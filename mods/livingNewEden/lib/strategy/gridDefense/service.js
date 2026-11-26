"use strict";

const { performance } = require("node:perf_hooks");
const { inSystemMoveMs } = require("../../fleets/grid/moveTime");
const { anchorRef } = require("../../fleets/grid/anchors");
const { gridOfRef, stationAnchorRef } = require("../../battle/gridContacts");
const { pairKeyOf } = require("../../battle/contacts");
const { isDefender, decideResponse, decideStep, activePursuitOf, isStrikeOperation, isStrikeFleet, DEFENDER_STATES,
  NON_COMBAT_ROLES, STRIKE_TARGET_STATES } = require("./decide");
const { STRIKE_ROLES } = require("../hunt/data/huntRules");
const { rankPosts, pickPost, relationOfControllers } = require("./posts");
const K = require("./keys");
const { crossingOf } = require("../../fleets/crossing");
const { transitTimelineOf, gatesOf, nextCrossingOf } = require("../../fleets/grid/transit");
const X = require("./crossing");
const { EVASIVE_ROLES } = require("../../battle/data/contactRules");

const PURSUIT = "PURSUIT";
const RETURN = "RETURN";
const POST = "POST";
const KIND_ANCHOR = "anchor";
const KIND_SYSTEM = "system";
const KIND_WARP = "warp";
const STAGED = "STAGED";
const WORMHOLE = "wormhole";
const STATIONS_READY = "ready";
const STATION_DESTROYED = "DESTROYED";
const SENTRIES_READY = "ready";
const SENTRY_OWNER_FACTION = "faction";
const SENTRY_FACTION_PREFIX = "sf-";
const RETRY_MOVE_REASONS = Object.freeze(["MOVE_FAILED", "ENQUEUE_FAILED", "FLEET_READ_FAILED"]);
const EXTRA_POSITIONS = 2;
const COUNTER_NAMES = Object.freeze(["alerts", "alertsStale", "locating", "notLocated", "pursuits", "pursuers",
  "retargets", "returns", "posts", "postsSameGrid", "inGrid", "outmatched", "busy", "cooldown", "evasive",
  "nonCombatSkipped", "noDefenders", "notDefender", "stepsStale", "drained", "moveRefused", "listenerReads",
  "listenerRefused", "siegePosts", "siegeRechecks", "siegeReleases",
  "crossingsQueued", "crossingChecks", "crossingsCaught", "crossingsEscaped", "crossingsTooFast", "crossingsNoGuard",
  "crossingsOutmatched", "crossingsCooldown", "crossingsEvasive", "crossingsNonCombat", "crossingsStale",
  "crossingListenerReads", "crossingListenerTruncated", "crossingPlaceFailed", "crossingsRefused",
  "strikeListenerReads", "strikePursuits", "strikeSameGrid", "strikeNoPin", "strikeEnds",
  "seenBySentry"]);
const FINAL_INTERCEPT_REFUSALS = Object.freeze(["STALE_LEG", "NOT_CROSSING", "LEG_HAS_WORMHOLES", "FLEET_NOT_FOUND"]);
const CROSSING_COUNTER = Object.freeze({ CATCH: "crossingsCaught", ESCAPED: "crossingsEscaped",
  TOO_FAST: "crossingsTooFast", NO_GUARD: "crossingsNoGuard", OUTMATCHED: "crossingsOutmatched",
  COOLDOWN: "crossingsCooldown", EVASIVE: "crossingsEvasive", NON_COMBAT_SKIPPED: "crossingsNonCombat" });
const CHAIN_OUTCOMES = Object.freeze(["NO_GUARD", "COOLDOWN", "OUTMATCHED", "ESCAPED"]);
const NULLSEC = "nullsec";
const RESPONSE_COUNTER = Object.freeze({ IN_GRID: "inGrid", NO_DEFENDERS: "noDefenders", OUTMATCHED: "outmatched",
  BUSY: "busy", COOLDOWN: "cooldown", EVASIVE: "evasive", NON_COMBAT_SKIPPED: "nonCombatSkipped" });
const MAX_DETAIL = 120;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const refOf = (a) => anchorRef(a.kind, a.id);

function createGridDefenseService(deps) {
  const { store, scheduler, settings: S } = deps;
  const repo = deps.fleets.repository;
  const grid = deps.fleets.grid;
  const worldSeed = Number.isSafeInteger(deps.worldSeed) ? deps.worldSeed : 0;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const scanLimit = Math.max(1, Math.min(S.scanFleets, S.maxPositionsPerCall - EXTRA_POSITIONS));
  let mode = deps.mode === "on" ? "on" : "drain";
  let lastRefusal = null;
  const strikeOn = () => mode === "on" && S.strikePursuitEnabled === true;

  const hostile = (a, b) => {
    try {
      return deps.isHostile(Number(a), Number(b)) === true;
    } catch (_err) {
      return false;
    }
  };

  function metric(kind, fullName, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](fullName, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `fleets.grid.defense.${name}`, n);
  }

  function noteRefusal(reason, fleetId) {
    lastRefusal = Object.freeze({ reason: String(reason || "REFUSED"), fleetId: fleetId ? String(fleetId) : null });
  }

  function soft(getter) {
    try {
      return typeof getter === "function" ? getter() || null : null;
    } catch (_err) {
      return null;
    }
  }

  function systemFleets(tx, systemId) {
    return repo.listFleetsInSystem(tx, systemId, { states: [...DEFENDER_STATES], limit: scanLimit });
  }

  function systemGridOf(systemId) {
    const r = grid.readSystemGrid(systemId);
    if (!r || r.ok !== true || !r.cp) return null;
    const gridOf = gridOfRef(r.grids);
    const cpRef = refOf(r.cp);
    const cpGridKey = gridOf.get(cpRef) || (r.cp.kind === KIND_SYSTEM ? cpRef : `${KIND_SYSTEM}:${systemId}`);
    return { anchors: r.anchors, gridOf, cp: r.cp, cpGridKey };
  }

  function positionsIn(tx, systemId, fleets, at) {
    const r = grid.positionsOf(tx, systemId, fleets, at, { withVisit: true });
    return r && r.ok === true && r.anchorsReason === null && r.positions instanceof Map ? r.positions : null;
  }

  function operationReader(tx) {
    const cache = new Map();
    return (fleet) => {
      const id = fleet.operationId;
      if (id === null || id === undefined) return { ok: true, operation: null };
      if (!cache.has(id)) cache.set(id, repo.getOperation(tx, id));
      return cache.get(id);
    };
  }

  function stationsIn(tx, systemId) {
    const st = soft(deps.getStations);
    try {
      if (!st || typeof st.getMode !== "function" || st.getMode() !== STATIONS_READY || !st.repository) return [];
      const r = st.repository.listStationsInSystem(tx, systemId);
      return r && r.ok === true && Array.isArray(r.records) ? r.records : [];
    } catch (_err) {
      return [];
    }
  }

  function sentryEyeIn(systemId, factions, gridOf, gridKey) {
    const se = soft(deps.getSentries);
    try {
      if (!se || typeof se.getMode !== "function" || se.getMode() !== SENTRIES_READY
        || typeof se.listLiveInSystem !== "function") return false;
      const live = se.listLiveInSystem(systemId);
      return Array.isArray(live) && live.some((r) => r && r.ownerKind === SENTRY_OWNER_FACTION
        && typeof r.sentryId === "string" && r.sentryId.startsWith(SENTRY_FACTION_PREFIX) && factions.has(r.factionId)
        && typeof r.anchorKind === "string" && gridOf.get(`${r.anchorKind}:${r.anchorId}`) === gridKey);
    } catch (_err) {
      return false;
    }
  }

  function withFleet(list, fleet) {
    if (!fleet || list.some((f) => f.fleetId === fleet.fleetId)) return list;
    return [...list, fleet];
  }

  function hostileDefenderIn(tx, systemId, factionId, exceptFleetId) {
    bump("listenerReads");
    const page = systemFleets(tx, systemId);
    if (!page || page.ok !== true) return false;
    return page.fleets.some((f) => f.fleetId !== exceptFleetId && S.roles.includes(f.fleetRole)
      && hostile(f.factionId, factionId));
  }

  function enqueueAlert(tx, a) {
    const key = K.alertKey(a.systemId, a.fleetId, a.legSeq, a.moveSeq);
    const dueAt = a.appearAt + S.seenReactionMs + K.jitterOf(worldSeed, key, S.reactionJitterMs);
    const payload = K.alertPayload({ ...a, phase: K.ALERT_PHASE.SEEN, at: dueAt });
    const r = scheduler.enqueue(K.ALERT_EVENT, a.systemId, dueAt, payload, key, { tx, chained: true });
    if (!r || r.ok !== true) {
      noteRefusal((r && r.reason) || "ENQUEUE_FAILED", a.fleetId);
      return r || { ok: false, reason: "ENQUEUE_FAILED" };
    }
    if (r.duplicate !== true) bump("alerts");
    return { ok: true };
  }

  function enqueueStep(tx, v, tag, dueAt) {
    const key = K.stepKey(v.fleetId, v.legSeq, v.moveSeq, tag);
    const payload = K.stepPayload({ ...v, at: dueAt });
    const r = scheduler.enqueue(K.STEP_EVENT, v.fleetId, dueAt, payload, key, { tx, chained: true });
    if (!r || r.ok !== true) {
      noteRefusal((r && r.reason) || "ENQUEUE_FAILED", v.fleetId);
      return r || { ok: false, reason: "ENQUEUE_FAILED" };
    }
    return { ok: true };
  }

  const listenerResult = (r) => {
    if (!r || r.ok !== true) bump("listenerRefused");
  };

  function onArrival(tx, a) {
    if (mode !== "on" || !a || !DEFENDER_STATES.includes(a.state)) return;
    if (S.roles.includes(a.fleetRole) && a.intercepted !== true) {
      const f = repo.getFleet(tx, a.fleetId);
      const fleet = f && f.ok === true ? f.fleet : null;
      const op = fleet ? operationReader(tx)(fleet) : null;
      if (fleet && op && op.ok === true && isDefender({ ...fleet, state: a.state }, op.operation, S)) {
        listenerResult(enqueueStep(tx, { fleetId: a.fleetId, systemId: a.systemId, legSeq: a.legSeq, moveSeq: 0,
          phase: K.STEP_PHASE.POST, targetFleetId: null }, K.stepTag.post(), a.at));
        return;
      }
    }
    if (strikeOn() && a.state === STAGED && a.intercepted !== true && STRIKE_ROLES.includes(a.fleetRole)) {
      bump("strikeListenerReads");
      const f = repo.getFleet(tx, a.fleetId);
      const fleet = f && f.ok === true ? f.fleet : null;
      const op = fleet ? operationReader(tx)(fleet) : null;
      if (op && op.ok === true && isStrikeOperation(op.operation)) {
        const tag = K.stepTag.strike();
        const key = K.stepKey(a.fleetId, a.legSeq, 0, tag);
        listenerResult(enqueueStep(tx, { fleetId: a.fleetId, systemId: a.systemId, legSeq: a.legSeq, moveSeq: 0,
          phase: K.STEP_PHASE.STRIKE, targetFleetId: null }, tag,
        a.at + S.seenReactionMs + K.jitterOf(worldSeed, key, S.reactionJitterMs)));
        return;
      }
    }
    const pos = positionsIn(tx, a.systemId, [{ fleetId: a.fleetId, state: a.state, currentSystemId: a.systemId,
      legSeq: a.legSeq }], a.at);
    const p = pos ? pos.get(a.fleetId) : null;
    if (!p || p.kind !== KIND_ANCHOR) return;
    if (p.visit && p.visit.moveSeq > 0) return;
    if (!hostileDefenderIn(tx, a.systemId, a.factionId, a.fleetId)) return;
    listenerResult(enqueueAlert(tx, { systemId: a.systemId, fleetId: a.fleetId, legSeq: a.legSeq,
      moveSeq: p.visit ? p.visit.moveSeq : 0, appearAt: a.at }));
  }

  function onGridArrival(tx, g) {
    if (mode !== "on" || !g) return;
    if (g.purpose === PURSUIT && typeof g.targetFleetId === "string") {
      const f = repo.getFleet(tx, g.fleetId);
      const fleet = f && f.ok === true ? f.fleet : null;
      const pos = fleet ? positionsIn(tx, g.systemId, [fleet], g.at) : null;
      const p = pos ? pos.get(g.fleetId) : null;
      const attempt = p && p.visit && p.visit.moveSeq === g.moveSeq ? p.visit.attempts : 0;
      listenerResult(enqueueStep(tx, { fleetId: g.fleetId, systemId: g.systemId, legSeq: g.legSeq,
        moveSeq: g.moveSeq, phase: K.STEP_PHASE.ARRIVED, targetFleetId: g.targetFleetId, attempt },
      K.stepTag.arr(), g.at));
      return;
    }
    if (g.purpose === RETURN) return;
    if (!hostileDefenderIn(tx, g.systemId, g.factionId, g.fleetId)) return;
    listenerResult(enqueueAlert(tx, { systemId: g.systemId, fleetId: g.fleetId, legSeq: g.legSeq,
      moveSeq: g.moveSeq, appearAt: g.at }));
  }

  function workOverride({ fleet, operation, arrival }) {
    if (mode !== "on" || !fleet || !arrival) return null;
    if (isDefender({ ...fleet, state: arrival.state }, operation, S)) return { kind: "STAY", rule: "GRID_DEFENSE_POST" };
    if (strikeOn() && STRIKE_ROLES.includes(fleet.fleetRole) && isStrikeOperation(operation)) {
      return { kind: "STAY", rule: "GRID_STRIKE_HOLD" };
    }
    return null;
  }

  const staleOf = (counter, reason) => ({ ok: true, outcome: "STALE", onCommitted: () => {
    bump(counter);
    if (reason) noteRefusal(reason, null);
  } });
  const drained = () => ({ ok: true, outcome: "STALE", onCommitted: () => bump("drained") });

  function moveOutcome(r, fleetId) {
    if (r && r.ok === true) return null;
    const reason = String((r && r.reason) || "MOVE_FAILED");
    if (RETRY_MOVE_REASONS.includes(reason)) return { ok: false, reason, detail: r && r.detail };
    return { ok: true, refused: reason, fleetId: (r && r.fleetId) || fleetId || null };
  }

  const afterMove = (onMoved) => (v) => {
    if (!v) return;
    if (v.refused) {
      bump("moveRefused");
      noteRefusal(v.refused, v.fleetId);
      return;
    }
    onMoved(v);
  };

  function readAlert(db, p) {
    const stale = (reason) => ({ ok: true, stale: reason });
    const f = repo.getFleet(db, p.fleetId);
    if (!f || f.ok !== true) return f || { ok: false, reason: "FLEET_READ_FAILED" };
    const intruder = f.fleet;
    if (!intruder || !DEFENDER_STATES.includes(intruder.state) || intruder.currentSystemId !== p.systemId
      || intruder.legSeq !== p.legSeq) return stale("INTRUDER_MOVED");
    const sg = systemGridOf(p.systemId);
    if (!sg) return stale("ANCHORS");
    const page = systemFleets(db, p.systemId);
    if (!page || page.ok !== true) return page || { ok: false, reason: "FLEETS_READ_FAILED" };
    const list = withFleet(page.fleets, intruder);
    const positions = positionsIn(db, p.systemId, list, p.at);
    if (!positions) return stale("ANCHORS");
    const ip = positions.get(intruder.fleetId);
    if (!ip || ip.kind !== KIND_ANCHOR || (ip.visit ? ip.visit.moveSeq : 0) !== p.moveSeq) return stale("POSITION");
    const opOf = operationReader(db);
    const defenders = [];
    const pursuitsByFaction = new Map();
    for (const fl of list) {
      if (fl.fleetId === intruder.fleetId || !S.roles.includes(fl.fleetRole) || !hostile(fl.factionId,
        intruder.factionId)) continue;
      const fp = positions.get(fl.fleetId);
      const pursuing = fp ? activePursuitOf(fp.visit, p.at, S) : null;
      if (pursuing) {
        if (!pursuitsByFaction.has(fl.factionId)) pursuitsByFaction.set(fl.factionId, new Set());
        pursuitsByFaction.get(fl.factionId).add(pursuing);
      }
      if (!fp || fp.kind !== KIND_ANCHOR) continue;
      const op = opOf(fl);
      if (!op || op.ok !== true) return op || { ok: false, reason: "OPERATION_READ_FAILED" };
      if (!isDefender(fl, op.operation, S)) continue;
      const eta = inSystemMoveMs(fl.composition, { position: fp.position || null }, { position: ip.position || null },
        { timeFactor: S.timeFactor });
      if (!eta.ok) continue;
      defenders.push({ fleetId: fl.fleetId, factionId: fl.factionId, strength: deps.strengthOf(fl.composition),
        gridKey: fp.gridKey, etaMs: eta.baseMs, pursuing, legSeq: fl.legSeq,
        moveSeq: fp.visit ? fp.visit.moveSeq : 0 });
    }
    const factions = new Set(defenders.map((d) => d.factionId));
    let seen = defenders.some((d) => d.gridKey === ip.gridKey);
    if (!seen && p.phase === K.ALERT_PHASE.SEEN && factions.size > 0) {
      seen = stationsIn(db, p.systemId).some((s) => {
        const ref = stationAnchorRef(s);
        return ref !== null && s.state !== STATION_DESTROYED && factions.has(s.ownerFactionId)
          && sg.gridOf.get(ref) === ip.gridKey;
      });
    }
    let seenBy = null;
    if (!seen && p.phase === K.ALERT_PHASE.SEEN && factions.size > 0 && deps.sentryEyes === true) {
      seen = sentryEyeIn(p.systemId, factions, sg.gridOf, ip.gridKey);
      if (seen) seenBy = "SENTRY";
    }
    const cooldownFactions = new Set();
    const battle = soft(deps.getBattle);
    if (battle && typeof battle.readCooldownsInTx === "function" && factions.size > 0) {
      const cd = battle.readCooldownsInTx(db, p.systemId);
      if (cd && cd.ok === true && cd.cooldowns instanceof Map) {
        for (const fid of factions) {
          const until = cd.cooldowns.get(pairKeyOf(fid, intruder.factionId));
          if (Number.isFinite(until) && until > p.at) cooldownFactions.add(fid);
        }
      }
    }
    return { ok: true, stale: null, seen, seenBy, defenders, pursuitsByFaction, cooldownFactions,
      cpGridKey: sg.cpGridKey,
      intruder: { fleetId: intruder.fleetId, factionId: intruder.factionId, fleetRole: intruder.fleetRole,
        strength: deps.strengthOf(intruder.composition), gridKey: ip.gridKey },
      anchor: Object.freeze({ kind: ip.anchorKind, id: ip.anchorId }) };
  }

  function isWormhole(systemId) {
    try {
      const g = deps.graph && typeof deps.graph.getGraph === "function" ? deps.graph.getGraph() : null;
      const graph = g && g.ok === true ? g.graph : null;
      const s = graph && typeof graph.getSystem === "function" ? graph.getSystem(systemId) : null;
      return Boolean(s && s.secClass === WORMHOLE);
    } catch (_err) {
      return false;
    }
  }

  function onAlert(ev) {
    try {
      const p = K.parseAlertPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "GRID_DEFENSE_PAYLOAD_INVALID", permanent: true };
      if (mode !== "on") return drained();
      const tx = store.transaction("gridDefense.alertRead", (db) => readAlert(db, p));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) return { ok: false, reason: String((read && read.reason) || "ALERT_READ_FAILED") };
      if (read.stale) return staleOf("alertsStale");
      if (p.phase === K.ALERT_PHASE.SEEN && !read.seen) {
        if (isWormhole(p.systemId) && S.whLocateEnabled !== true) {
          return { ok: true, outcome: "NOT_LOCATED", onCommitted: () => bump("notLocated") };
        }
        const key = K.locateAlertKey(K.alertKey(p.systemId, p.fleetId, p.legSeq, p.moveSeq));
        const dueAt = Math.max(p.at, p.appearAt + S.locateMs + K.jitterOf(worldSeed, key, S.reactionJitterMs));
        return { ok: true, outcome: "LOCATING", effect: (etx) => {
          const r = scheduler.enqueue(K.ALERT_EVENT, p.systemId, dueAt, K.alertPayload({ ...p,
            phase: K.ALERT_PHASE.LOCATE, at: dueAt }), key, { tx: etx, chained: true });
          return r && r.ok === true ? { ok: true } : { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
        }, onCommitted: () => bump("locating") };
      }
      const t0 = nowMs();
      const d = decideResponse({ intruder: read.intruder, defenders: read.defenders, cpGridKey: read.cpGridKey,
        pursuitsByFaction: read.pursuitsByFaction, cooldownFactions: read.cooldownFactions, isHostile: hostile,
        settings: S });
      metric("observe", "fleets.grid.defense.decideMs", Math.max(0, nowMs() - t0));
      const eye = () => {
        if (read.seenBy === "SENTRY") bump("seenBySentry");
      };
      if (d.kind !== "PURSUE") {
        return { ok: true, outcome: d.kind, onCommitted: () => {
          eye();
          bump(RESPONSE_COUNTER[d.kind]);
        } };
      }
      const byFleet = new Map(read.defenders.map((x) => [x.fleetId, x]));
      const members = d.pursuers.map((id) => ({ fleetId: id, legSeq: byFleet.get(id).legSeq,
        expectedMoveSeq: byFleet.get(id).moveSeq }));
      return { ok: true, outcome: "PURSUE", effect: (etx) => {
        const r = grid.moveGroupInTx(etx, { systemId: p.systemId, at: p.at, to: read.anchor, purpose: PURSUIT,
          targetFleetId: read.intruder.fleetId, attempts: 0, members }, { chained: true });
        const refused = moveOutcome(r, null);
        return refused || { ok: true, moved: r.moved.length };
      }, onCommitted: (v) => {
        eye();
        afterMove((w) => {
          bump("pursuits");
          bump("pursuers", w.moved);
        })(v);
      } };
    } catch (err) {
      return { ok: false, reason: `GRID_DEFENSE_ALERT_FAILED: ${messageOf(err)}` };
    }
  }

  function postsOf(db, systemId, factionId, sg, list, opOf) {
    const targets = [...new Set(sg.anchors.filter((a) => a && a.kind === "gate" && isId(a.toSystemId))
      .map((a) => a.toSystemId))];
    const relationOf = new Map();
    const world = soft(deps.getWorld);
    if (world && world.repository && typeof world.repository.getSystems === "function" && targets.length > 0) {
      try {
        const r = world.repository.getSystems(db, targets);
        const rows = r && r.ok === true && Array.isArray(r.systems) ? r.systems : [];
        for (const [systemId, rel] of relationOfControllers(rows, factionId, hostile)) relationOf.set(systemId, rel);
      } catch (err) {
        if (!db || db.inTransaction !== true) throw err;
      }
    }
    const own = stationsIn(db, systemId).filter((s) => s.ownerFactionId === factionId && s.state !== STATION_DESTROYED);
    const ownStationRefs = new Set(own.map(stationAnchorRef).filter((ref) => ref !== null));
    const sieged = siegeRefsOf(db, systemId, factionId, own);
    const siegeRefs = sieged.refs;
    const defenderIds = [];
    for (const fl of list) {
      if (fl.factionId !== factionId || !S.roles.includes(fl.fleetRole)) continue;
      const op = opOf(fl);
      if (op && op.ok === true && isDefender(fl, op.operation, S)) defenderIds.push(fl.fleetId);
    }
    const cp = sg.cp && sg.cp.kind !== KIND_SYSTEM ? sg.cp : null;
    const posts = rankPosts({ anchors: sg.anchors, gridOf: sg.gridOf, cp, factionId, relationOf, ownStationRefs,
      siegeRefs });
    const siege = siegeRefs.size > 0 && posts.length > 0 && posts.every((a) => siegeRefs.has(refOf(a)));
    return { posts, defenderIds: defenderIds.sort(byId), siege, siegeUntil: siege ? sieged.until : null };
  }

  function siegeRefsOf(db, systemId, factionId, ownStations) {
    const out = { refs: new Set(), until: null };
    if (S.siegePosts !== true || ownStations.length === 0) return out;
    const siege = soft(deps.getSiege);
    if (!siege || typeof siege.readForFaction !== "function") return out;
    try {
      const r = siege.readForFaction(db, factionId, { limit: S.siegeReadLimit });
      if (!r || r.ok !== true || !Array.isArray(r.defending)) return out;
      const here = r.defending.filter((d) => d && d.systemId === systemId);
      const byStation = new Map(here.map((d) => [d.stationId, d]));
      for (const s of ownStations) {
        const ref = byStation.has(s.stationId) ? stationAnchorRef(s) : null;
        if (ref === null) continue;
        out.refs.add(ref);
        const end = byStation.get(s.stationId).phaseEndsAt;
        if (Number.isSafeInteger(end) && (out.until === null || end < out.until)) out.until = end;
      }
    } catch (err) {
      if (!db || db.inTransaction !== true) throw err;
    }
    return out;
  }

  function enqueueSiegeRecheck(tx, v, round, at, until, arriveAt) {
    const key = K.stepKey(v.fleetId, v.legSeq, v.moveSeq, K.stepTag.sp(round));
    const base = Math.max(at + S.siegeRecheckMs, Number.isSafeInteger(until) ? until : 0,
      Number.isSafeInteger(arriveAt) ? arriveAt : 0);
    const dueAt = base + S.seenReactionMs + K.jitterOf(worldSeed, key, S.reactionJitterMs);
    return enqueueStep(tx, { ...v, phase: K.STEP_PHASE.POST, targetFleetId: null, attempt: 0, round },
      K.stepTag.sp(round), dueAt);
  }

  function postOf(postInfo, fleetId) {
    const pick = pickPost({ posts: postInfo.posts, defenderIds: postInfo.defenderIds, fleetId, maxPosts: S.maxPosts });
    return pick.anchor && pick.anchor.kind !== KIND_SYSTEM ? Object.freeze({ kind: pick.anchor.kind,
      id: pick.anchor.id }) : null;
  }

  const hostileDefenderOf = (list, self) => list.some((x) => x.fleetId !== self.fleetId && S.roles.includes(x.fleetRole)
    && hostile(x.factionId, self.factionId));

  function readStrike(db, p, self, page) {
    const stale = (reason) => ({ ok: true, kind: "STALE", reason });
    if (!DEFENDER_STATES.includes(self.state)) return stale("NOT_MOVABLE");
    const hunt = soft(deps.getHunt);
    const pins = hunt && hunt.repository && typeof hunt.repository.getActivePinForStrike === "function"
      ? hunt.repository : null;
    let why = pins ? null : "HUNT_UNAVAILABLE";
    let target = null;
    if (pins) {
      const r = pins.getActivePinForStrike(db, self.fleetId, p.systemId);
      if (!r || r.ok !== true) return r || { ok: false, reason: "PIN_READ_FAILED" };
      const pin = r.pin;
      if (!pin || pin.targetKind !== "fleet" || typeof pin.targetFleetId !== "string" || !pin.targetFleetId) {
        why = "NO_PIN";
      } else {
        const t = repo.getFleet(db, pin.targetFleetId);
        if (!t || t.ok !== true) return t || { ok: false, reason: "FLEET_READ_FAILED" };
        target = t.fleet;
      }
    }
    const here = target && target.currentSystemId === p.systemId ? target : null;
    const list = withFleet(withFleet(page.fleets, self), here);
    const positions = positionsIn(db, p.systemId, list, p.at);
    if (!positions) return stale("ANCHORS");
    const sp = positions.get(self.fleetId);
    if (!sp || (sp.visit ? sp.visit.moveSeq : 0) !== p.moveSeq) return stale("VISIT_MOVED");
    const hostileDefender = hostileDefenderOf(list, self);
    if (why !== null) return { ok: true, kind: "STRIKE_NO_PIN", why, hostileDefender };
    const tp = here && STRIKE_TARGET_STATES.includes(here.state) ? positions.get(here.fleetId) : null;
    if (tp && tp.kind === KIND_WARP && tp.to && tp.to.kind) {
      return { ok: true, kind: "STRIKE_PURSUE", anchor: Object.freeze({ kind: tp.to.kind, id: tp.to.id }),
        targetFleetId: here.fleetId };
    }
    if (!tp || tp.kind !== KIND_ANCHOR) return { ok: true, kind: "STRIKE_NO_PIN", why: "TARGET_GONE", hostileDefender };
    const selfGrid = sp.kind === KIND_ANCHOR ? sp.gridKey : null;
    if (selfGrid !== null && tp.gridKey === selfGrid) return { ok: true, kind: "STRIKE_SAME_GRID", hostileDefender };
    return { ok: true, kind: "STRIKE_PURSUE", anchor: Object.freeze({ kind: tp.anchorKind, id: tp.anchorId }),
      targetFleetId: here.fleetId };
  }

  function strikeClassOf(fl, opOf) {
    if (!S.roles.includes(fl.fleetRole) || !STRIKE_ROLES.includes(fl.fleetRole)) {
      return { ok: true, strike: isStrikeFleet(fl, null, S) };
    }
    const op = opOf(fl);
    if (!op || op.ok !== true) return op || { ok: false, reason: "OPERATION_READ_FAILED" };
    return { ok: true, strike: isStrikeFleet(fl, op.operation, S) };
  }

  function readStep(db, p) {
    const stale = (reason) => ({ ok: true, kind: "STALE", reason });
    if (p.phase === K.STEP_PHASE.STRIKE && S.strikePursuitEnabled !== true) return stale("STRIKE_OFF");
    const f = repo.getFleet(db, p.fleetId);
    if (!f || f.ok !== true) return f || { ok: false, reason: "FLEET_READ_FAILED" };
    const self = f.fleet;
    if (!self || self.currentSystemId !== p.systemId || self.legSeq !== p.legSeq) return stale("FLEET_MOVED");
    const sg = systemGridOf(p.systemId);
    if (!sg) return stale("ANCHORS");
    const page = systemFleets(db, p.systemId);
    if (!page || page.ok !== true) return page || { ok: false, reason: "FLEETS_READ_FAILED" };
    if (p.phase === K.STEP_PHASE.STRIKE) return readStrike(db, p, self, page);
    let target = null;
    if (p.targetFleetId !== null) {
      const t = repo.getFleet(db, p.targetFleetId);
      if (!t || t.ok !== true) return t || { ok: false, reason: "FLEET_READ_FAILED" };
      target = t.fleet;
    }
    const list = withFleet(withFleet(page.fleets, self), target && target.currentSystemId === p.systemId ? target
      : null);
    const positions = positionsIn(db, p.systemId, list, p.at);
    if (!positions) return stale("ANCHORS");
    const sp = positions.get(self.fleetId);
    if (!sp || (sp.visit ? sp.visit.moveSeq : 0) !== p.moveSeq) return stale("VISIT_MOVED");
    const opOf = operationReader(db);
    const selfGrid = sp.kind === KIND_ANCHOR ? sp.gridKey : null;

    if (p.phase === K.STEP_PHASE.POST) {
      if (!DEFENDER_STATES.includes(self.state)) return stale("NOT_MOVABLE");
      const op = opOf(self);
      if (!op || op.ok !== true) return op || { ok: false, reason: "OPERATION_READ_FAILED" };
      if (!isDefender(self, op.operation, S)) return { ok: true, kind: "NOT_DEFENDER" };
      const postInfo = postsOf(db, p.systemId, self.factionId, sg, list, opOf);
      const post = postOf(postInfo, self.fleetId);
      if (post === null) return stale("NO_POST");
      const postGrid = sg.gridOf.get(refOf(post)) || refOf(post);
      const hostileDefender = hostileDefenderOf(list, self);
      return { ok: true, kind: selfGrid === postGrid ? "SAME_GRID" : "POSTED", post, hostileDefender,
        siegePost: postInfo.siege === true, siegeUntil: postInfo.siegeUntil };
    }

    const selfClass = strikeClassOf(self, opOf);
    if (!selfClass.ok) return selfClass;
    if (selfClass.strike && S.strikePursuitEnabled !== true) return stale("STRIKE_OFF");
    const d = decideStep({ phase: p.phase, attempt: p.attempt, round: p.round,
      self: { state: self.state, gridKey: selfGrid },
      target: target ? { state: target.state, inSystem: target.currentSystemId === p.systemId,
        position: positions.get(target.fleetId) || null } : null, settings: S });
    if (d.kind !== "RETARGET" && d.kind !== "RETURN") return { ok: true, ...d };
    if (selfClass.strike) {
      if (d.kind === "RETURN") return { ok: true, kind: "STRIKE_END", reason: d.reason };
      const tp = positions.get(target.fleetId);
      return { ok: true, ...d, group: [{ fleetId: self.fleetId, legSeq: self.legSeq,
        expectedMoveSeq: sp.visit ? sp.visit.moveSeq : 0 }], anchor: Object.freeze({ kind: tp.anchorKind,
        id: tp.anchorId }) };
    }
    const anchored = list.filter((x) => x.factionId === self.factionId && DEFENDER_STATES.includes(x.state))
      .map((x) => ({ fleet: x, pos: positions.get(x.fleetId) }))
      .filter((m) => m.pos && m.pos.kind === KIND_ANCHOR && m.pos.visit && m.pos.visit.purpose === PURSUIT
        && m.pos.visit.targetFleetId === p.targetFleetId);
    const members = [];
    for (const m of anchored) {
      if (m.fleet.fleetId !== self.fleetId) {
        const c = strikeClassOf(m.fleet, opOf);
        if (!c.ok) return c;
        if (c.strike) continue;
      }
      members.push(m);
    }
    const group = members
      .sort((a, b) => (a.fleet.fleetId === self.fleetId ? -1 : b.fleet.fleetId === self.fleetId ? 1
        : byId(a.fleet.fleetId, b.fleet.fleetId)))
      .slice(0, S.maxPursuersPerIntruder)
      .map((m) => ({ fleetId: m.fleet.fleetId, legSeq: m.fleet.legSeq, expectedMoveSeq: m.pos.visit.moveSeq }));
    if (d.kind === "RETARGET") {
      const tp = positions.get(target.fleetId);
      if (group.length === 0) return stale("NO_GROUP");
      return { ok: true, ...d, group, anchor: Object.freeze({ kind: tp.anchorKind, id: tp.anchorId }) };
    }
    const postInfo = postsOf(db, p.systemId, self.factionId, sg, list, opOf);
    const returns = group.map((m) => ({ ...m, post: postOf(postInfo, m.fleetId) })).filter((m) => m.post !== null);
    return { ok: true, ...d, returns, siegePost: postInfo.siege === true, siegeUntil: postInfo.siegeUntil };
  }

  function returnEffect(etx, p, returns, siege) {
    let moved = 0;
    let refused = 0;
    let rechecks = 0;
    for (const m of returns) {
      const r = grid.moveInTx(etx, { fleetId: m.fleetId, systemId: p.systemId, legSeq: m.legSeq, at: p.at, to: m.post,
        purpose: RETURN, expectedMoveSeq: m.expectedMoveSeq }, { chained: true });
      const out = moveOutcome(r, m.fleetId);
      if (out && out.ok === false) return out;
      if (out) {
        refused += 1;
        noteRefusal(out.refused, m.fleetId);
        continue;
      }
      if (r.moved === true) moved += 1;
      if (siege) {
        const e = enqueueSiegeRecheck(etx, { fleetId: m.fleetId, systemId: p.systemId, legSeq: m.legSeq,
          moveSeq: r.moved === true ? r.moveSeq : m.expectedMoveSeq }, 1, p.at, siege.until,
        r.moved === true ? r.arriveAt : null);
        if (!e.ok) return e;
        rechecks += 1;
      }
    }
    return { ok: true, moved, refusedCount: refused, rechecks };
  }

  function onStep(ev) {
    try {
      const p = K.parseStepPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "GRID_DEFENSE_PAYLOAD_INVALID", permanent: true };
      if (mode !== "on") return drained();
      const tx = store.transaction("gridDefense.stepRead", (db) => readStep(db, p));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) return { ok: false, reason: String((read && read.reason) || "STEP_READ_FAILED") };
      const base = { fleetId: p.fleetId, systemId: p.systemId, legSeq: p.legSeq, moveSeq: p.moveSeq,
        targetFleetId: p.targetFleetId, attempt: p.attempt, round: p.round };
      const chain = (phase, tag, dueAt, extra) => (etx) => enqueueStep(etx, { ...base, ...extra, phase }, tag, dueAt);
      switch (read.kind) {
        case "STALE":
          return staleOf("stepsStale");
        case "NOT_DEFENDER":
          return { ok: true, outcome: "NOT_DEFENDER", onCommitted: () => bump("notDefender") };
        case "SAME_GRID":
          return { ok: true, outcome: "SAME_GRID", effect: (etx) => {
            const a = read.hostileDefender ? enqueueAlert(etx, { systemId: p.systemId, fleetId: p.fleetId,
              legSeq: p.legSeq, moveSeq: p.moveSeq, appearAt: p.at }) : { ok: true };
            if (!a || a.ok !== true || !read.siegePost) return a;
            const e = enqueueSiegeRecheck(etx, p, p.round + 1, p.at, read.siegeUntil, null);
            return e.ok ? { ok: true, rechecks: 1 } : e;
          }, onCommitted: (v) => {
            bump("postsSameGrid");
            if (read.siegePost) bump("siegePosts");
            if (v && v.rechecks) bump("siegeRechecks", v.rechecks);
          } };
        case "POSTED":
          return { ok: true, outcome: "POSTED", effect: (etx) => {
            const r = grid.moveInTx(etx, { fleetId: p.fleetId, systemId: p.systemId, legSeq: p.legSeq, at: p.at,
              to: read.post, purpose: POST, expectedMoveSeq: p.moveSeq }, { chained: true });
            const refused = moveOutcome(r, p.fleetId);
            if (refused || !read.siegePost) return refused || { ok: true, moved: r.moved === true };
            const moved = r.moved === true;
            const e = enqueueSiegeRecheck(etx, { ...p, moveSeq: moved ? r.moveSeq : p.moveSeq }, p.round + 1, p.at,
              read.siegeUntil, moved ? r.arriveAt : null);
            return e.ok ? { ok: true, moved, rechecks: 1 } : e;
          }, onCommitted: afterMove((v) => {
            bump(v.moved ? "posts" : "postsSameGrid");
            if (read.siegePost) bump("siegePosts");
            if (v.rechecks) bump("siegeRechecks", v.rechecks);
            if (p.round > 0 && v.moved && !read.siegePost) bump("siegeReleases");
          }) };
        case "CONTACT":
          return { ok: true, outcome: "CONTACT", effect: chain(K.STEP_PHASE.RETURN, K.stepTag.ret(1),
            p.at + S.returnAfterMs, { round: 1 }) };
        case "WAIT_ENGAGED":
          return { ok: true, outcome: "WAIT_ENGAGED", effect: chain(K.STEP_PHASE.RETURN, K.stepTag.ret(read.round),
            p.at + S.returnAfterMs, { round: read.round }) };
        case "LOCATE": {
          const tag = K.stepTag.loc(read.attempt);
          const key = K.stepKey(p.fleetId, p.legSeq, p.moveSeq, tag);
          return { ok: true, outcome: "LOCATE", effect: chain(K.STEP_PHASE.LOCATE, tag,
            p.at + S.locateMs + K.jitterOf(worldSeed, key, S.reactionJitterMs), { attempt: read.attempt }) };
        }
        case "RETARGET":
          return { ok: true, outcome: "RETARGET", effect: (etx) => {
            const r = grid.moveGroupInTx(etx, { systemId: p.systemId, at: p.at, to: read.anchor, purpose: PURSUIT,
              targetFleetId: p.targetFleetId, attempts: read.attempts, members: read.group }, { chained: true });
            return moveOutcome(r, p.fleetId) || { ok: true, moved: r.moved.length };
          }, onCommitted: afterMove(() => bump("retargets")) };
        case "RETURN":
          return { ok: true, outcome: "RETURN", effect: (etx) => returnEffect(etx, p, read.returns,
            read.siegePost ? { until: read.siegeUntil } : null),
            onCommitted: (v) => {
              if (!v) return;
              bump("returns", v.moved);
              bump("moveRefused", v.refusedCount);
              if (read.siegePost) bump("siegePosts", v.moved);
              bump("siegeRechecks", v.rechecks);
            } };
        case "STRIKE_PURSUE":
          return { ok: true, outcome: "STRIKE_PURSUE", effect: (etx) => {
            const r = grid.moveInTx(etx, { fleetId: p.fleetId, systemId: p.systemId, legSeq: p.legSeq, at: p.at,
              to: read.anchor, purpose: PURSUIT, targetFleetId: read.targetFleetId, attempts: 0,
              expectedMoveSeq: p.moveSeq }, { chained: true });
            return moveOutcome(r, p.fleetId) || { ok: true, moved: r.moved === true };
          }, onCommitted: afterMove((v) => bump(v.moved ? "strikePursuits" : "strikeSameGrid")) };
        case "STRIKE_SAME_GRID":
        case "STRIKE_NO_PIN": {
          const noPin = read.kind === "STRIKE_NO_PIN";
          return { ok: true, outcome: read.kind, effect: (etx) => (read.hostileDefender ? enqueueAlert(etx,
            { systemId: p.systemId, fleetId: p.fleetId, legSeq: p.legSeq, moveSeq: p.moveSeq, appearAt: p.at })
            : { ok: true }), onCommitted: () => {
            bump(noPin ? "strikeNoPin" : "strikeSameGrid");
            if (noPin) noteRefusal(read.why, p.fleetId);
          } };
        }
        case "STRIKE_END":
          return { ok: true, outcome: "STRIKE_END", onCommitted: () => bump("strikeEnds") };
        default:
          return staleOf("stepsStale", String(read.kind));
      }
    } catch (err) {
      return { ok: false, reason: `GRID_DEFENSE_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  const C = S.crossings;
  const crossingsOn = () => mode === "on" && Boolean(C) && C.enabled === true;

  function secClassOf(systemId) {
    try {
      const g = deps.graph && typeof deps.graph.getGraph === "function" ? deps.graph.getGraph() : null;
      const graph = g && g.ok === true ? g.graph : null;
      const s = graph && typeof graph.getSystem === "function" ? graph.getSystem(systemId) : null;
      return s ? s.secClass : null;
    } catch (_err) {
      return null;
    }
  }

  const exposureOf = (systemId) => (secClassOf(systemId) === NULLSEC ? C.nullExitExposureMs : C.exitExposureMs);

  function crossingCandidates(tx, systemIds, factionId, transitId) {
    const set = new Set();
    if (systemIds.length === 0) return { ok: true, set, truncated: false };
    const r = repo.listFleetsInSystems(tx, systemIds, { states: [...DEFENDER_STATES],
      limitPerSystem: C.listenerScanFleets });
    if (!r || r.ok !== true || !(r.bySystem instanceof Map)) return r || { ok: false, reason: "FLEETS_READ_FAILED" };
    let truncated = false;
    for (const [systemId, list] of r.bySystem) {
      if (list.length >= C.listenerScanFleets) truncated = true;
      if (list.some((f) => f.fleetId !== transitId && S.roles.includes(f.fleetRole) && hostile(f.factionId, factionId))) {
        set.add(systemId);
      }
    }
    return { ok: true, set, truncated };
  }

  function enqueueCrossing(tx, v, chained) {
    const key = X.crossingKey(v.fleetId, v.legSeq, v.systemIndex, v.gate);
    const r = scheduler.enqueue(X.EVENT_TYPE, v.fleetId, v.at, X.crossingPayload(v), key, { tx, chained });
    if (!r || r.ok !== true) {
      noteRefusal((r && r.reason) || "ENQUEUE_FAILED", v.fleetId);
      return r || { ok: false, reason: "ENQUEUE_FAILED" };
    }
    if (r.duplicate !== true) bump("crossingsQueued");
    return { ok: true };
  }

  function onDeparture(tx, d) {
    if (!crossingsOn() || !d || d.wormholes === true || !d.leg || !Array.isArray(d.leg.systems)
      || d.leg.systems.length < 3) return;
    if (EVASIVE_ROLES.includes(d.fleetRole) || (NON_COMBAT_ROLES.includes(d.fleetRole) && S.chaseNonCombat !== true)) {
      return;
    }
    const t0 = nowMs();
    try {
      const systems = d.leg.systems;
      const inner = systems.slice(1, Math.min(systems.length - 2, C.listenerMaxSystems) + 1);
      bump("crossingListenerReads");
      const c = crossingCandidates(tx, inner, d.factionId, d.fleetId);
      if (!c.ok) {
        listenerResult(c);
        return;
      }
      if (c.truncated) bump("crossingListenerTruncated");
      if (c.set.size === 0) return;
      const f = repo.getFleet(tx, d.fleetId);
      const fleet = f && f.ok === true ? f.fleet : null;
      if (!fleet) {
        listenerResult(f && f.ok === false ? f : { ok: false, reason: "FLEET_NOT_FOUND" });
        return;
      }
      const next = nextCrossingOf(d.leg, fleet.composition, null, c.set, exposureOf, C);
      if (!next) return;
      listenerResult(enqueueCrossing(tx, { ...next, fleetId: d.fleetId, legSeq: d.legSeq, check: 0 },
        d.chained === true));
    } finally {
      metric("observe", "fleets.grid.defense.crossingListenerMs", Math.max(0, nowMs() - t0));
    }
  }

  function readCrossing(db, p) {
    const stale = (reason, next = null) => ({ ok: true, stale: reason, next });
    const f = repo.getFleet(db, p.fleetId);
    if (!f || f.ok !== true) return f || { ok: false, reason: "FLEET_READ_FAILED" };
    const transit = f.fleet;
    if (!transit || transit.legSeq !== p.legSeq) return stale("LEG_MOVED");
    const c = crossingOf(transit, p.systemId);
    if (!c || c.i !== p.systemIndex) return stale("LEG_MOVED");
    const tl = transitTimelineOf(c.leg, c.i, transit.composition);
    if (!tl.ok || p.at < tl.from || p.at >= tl.until) return stale("LEG_MOVED");
    let next = null;
    if (p.check + 1 < C.maxChecksPerLeg) {
      const systems = c.leg.systems;
      const range = systems.slice(c.i, Math.min(systems.length - 2, c.i + C.listenerMaxSystems - 1) + 1);
      const cand = crossingCandidates(db, range, transit.factionId, transit.fleetId);
      if (!cand.ok) return cand;
      next = nextCrossingOf(c.leg, transit.composition, { i: c.i, gate: p.gate }, cand.set, exposureOf, C);
    }
    const sg = systemGridOf(p.systemId);
    const gate = sg ? gatesOf(sg.anchors, c.leg, c.i)[p.gate] : null;
    if (!gate) return stale("NO_GATE", next);
    const gateGrid = sg.gridOf.get(refOf(gate)) || refOf(gate);
    const page = systemFleets(db, p.systemId);
    if (!page || page.ok !== true) return page || { ok: false, reason: "FLEETS_READ_FAILED" };
    const positions = positionsIn(db, p.systemId, page.fleets, p.at);
    if (!positions) return stale("NO_GATE", next);
    const opOf = operationReader(db);
    const guards = [];
    for (const fl of page.fleets) {
      if (fl.fleetId === transit.fleetId || !S.roles.includes(fl.fleetRole) || !hostile(fl.factionId,
        transit.factionId)) continue;
      const fp = positions.get(fl.fleetId);
      if (!fp || fp.kind !== KIND_ANCHOR || fp.gridKey !== gateGrid) continue;
      const op = opOf(fl);
      if (!op || op.ok !== true) return op || { ok: false, reason: "OPERATION_READ_FAILED" };
      if (!isDefender(fl, op.operation, S)) continue;
      guards.push({ fleetId: fl.fleetId, factionId: fl.factionId, strength: deps.strengthOf(fl.composition) });
    }
    const cooldownFactions = new Set();
    const factions = new Set(guards.map((g) => g.factionId));
    const battle = soft(deps.getBattle);
    if (battle && typeof battle.readCooldownsInTx === "function" && factions.size > 0) {
      const cd = battle.readCooldownsInTx(db, p.systemId);
      if (cd && cd.ok === true && cd.cooldowns instanceof Map) {
        for (const fid of factions) {
          const until = cd.cooldowns.get(pairKeyOf(fid, transit.factionId));
          if (Number.isFinite(until) && until > p.at) cooldownFactions.add(fid);
        }
      }
    }
    return { ok: true, stale: null, next, guards, cooldownFactions, exposureMs: exposureOf(p.systemId),
      expectedVersion: transit.version, gateAnchor: Object.freeze({ kind: gate.kind, id: gate.id }),
      transit: { fleetId: transit.fleetId, factionId: transit.factionId, fleetRole: transit.fleetRole,
        strength: deps.strengthOf(transit.composition), alignRaw: tl.alignRaw } };
  }

  function catchEffect(etx, p, key, read) {
    const r = deps.fleets.travel.interceptInTx(etx, { at: p.at, expectedVersion: read.expectedVersion,
      fleetId: p.fleetId, legSeq: p.legSeq, systemIndex: p.systemIndex }, X.haltKeyOf(key), { chained: true });
    if (!r || r.ok !== true) {
      const reason = String((r && r.reason) || "INTERCEPT_FAILED");
      if (FINAL_INTERCEPT_REFUSALS.includes(reason)) return { ok: true, refused: reason };
      return { ok: false, reason, ...(reason === "FLEET_INVALID_INPUT" ? { permanent: true } : {}) };
    }
    if (r.duplicate === true) return { ok: true, caught: false, duplicate: true };
    if (p.gate === "out") {
      const pl = grid.placeInTx(etx, { fleetId: p.fleetId, systemId: p.systemId, legSeq: p.legSeq, at: p.at,
        anchor: read.gateAnchor });
      if (!pl || pl.ok !== true || pl.placed !== true) {
        bump("crossingPlaceFailed");
        return { ok: false, reason: "CROSSING_PLACE_FAILED", permanent: true,
          detail: String((pl && pl.reason) || "NOT_PLACED") };
      }
    }
    return { ok: true, caught: true };
  }

  function onCrossing(ev) {
    try {
      const p = X.parseCrossingPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "GRID_CROSSING_PAYLOAD_INVALID", permanent: true };
      if (!crossingsOn()) return drained();
      const tx = store.transaction("gridDefense.crossingRead", (db) => readCrossing(db, p));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        return { ok: false, reason: String((read && read.reason) || "CROSSING_READ_FAILED") };
      }
      const chainNext = (etx) => (read.next ? enqueueCrossing(etx, { ...read.next, fleetId: p.fleetId,
        legSeq: p.legSeq, check: p.check + 1 }, true) : { ok: true });
      const counted = (name) => () => {
        bump("crossingChecks");
        bump(name);
      };
      if (read.stale) {
        return { ok: true, outcome: "STALE", ...(read.stale === "LEG_MOVED" ? {} : { effect: chainNext }),
          onCommitted: () => {
            counted("crossingsStale")();
            noteRefusal(read.stale, p.fleetId);
          } };
      }
      const key = X.crossingKey(p.fleetId, p.legSeq, p.systemIndex, p.gate);
      const d = X.decideCrossing({ transit: read.transit, gate: p.gate, exposureMs: read.exposureMs,
        guards: read.guards, cooldownFactions: read.cooldownFactions, roll: X.rollOf(worldSeed, key),
        settings: { chaseNonCombat: S.chaseNonCombat, lockMs: C.lockMs, minStrengthPermille: C.minStrengthPermille,
          catchChancePermille: C.catchChancePermille } });
      if (d.kind === "CATCH") {
        return { ok: true, outcome: "CATCH", effect: (etx) => catchEffect(etx, p, key, read), onCommitted: (v) => {
          bump("crossingChecks");
          if (v && v.refused) {
            bump("crossingsRefused");
            noteRefusal(v.refused, p.fleetId);
          } else if (v && v.caught) bump("crossingsCaught");
        } };
      }
      return { ok: true, outcome: d.kind, ...(CHAIN_OUTCOMES.includes(d.kind) ? { effect: chainNext } : {}),
        onCommitted: counted(CROSSING_COUNTER[d.kind]) };
    } catch (err) {
      return { ok: false, reason: `GRID_CROSSING_FAILED: ${messageOf(err)}` };
    }
  }

  function getStatus() {
    return Object.freeze({ mode, counters: Object.freeze({ ...counters }), lastRefusal });
  }

  return Object.freeze({ onArrival, onGridArrival, workOverride, onAlert, onStep, onDeparture, onCrossing, getStatus,
    getMode: () => mode,
    stop() {
      mode = "off";
    } });
}

module.exports = { createGridDefenseService, COUNTER_NAMES };
