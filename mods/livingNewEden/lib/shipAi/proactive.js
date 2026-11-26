"use strict";

const { createPoller } = require("../presence/poller");
const { buildSystemPrompt, staticLineWith } = require("./persona");
const { filterReply } = require("./filter");
const { sanitizeGameText } = require("./context");
const { fleetsAround, toolMapFor } = require("./tools/catalog");
const { createObserver, detectEvents, lowHpEvent, isCapsule } = require("./events");
const { planCallout, buildCallout, isHostileFaction, classKeyOf, RANK } = require("./callout");
const { planWingHp, takeWingLine, buildWingHpLine, buildWingLossLine, forgetCopy } = require("./wingHp");
const { PROACTIVE_RULE, PROACTIVE_USER, PROACTIVE_TOOL_RULE, TOOL_HINTS } = require("./data/persona");
const { METRIC, WATCH_KINDS, MUTE_KINDS, RAM_TRIGGER_KINDS } = require("./schema");
const { planAbyssal, parseWarnList } = require("./abyssalLines");
const { emptyTriggerState, planTriggers, takeTrigger, parseSecThresholds, activityEntryOf, noteActivity,
  parseNameList, TRIGGER_KINDS_B, markActivitySpoken, watchTemplateOf, watchValuesOf,
  welcomeDecision, worldEntriesOf, planHere, parseWorldKinds } = require("./triggers");
const { TRIGGER_PRIORITY, LAYER_NAMES } = require("./data/triggers");
const { systemsWithin } = require("../notices/recipients");
const { UNKNOWN } = require("../names/fallback");

const WORK_CLASS = "MAINTENANCE";
const LANE = "proactive";
const STATIC = "static";
const MODEL = "model";
const PRIORITY = Object.freeze({ LOSS_POD: 100, LOSS_SHIP: 90, LOW_HP: 80,
  WING_LOSS: 79, WING_HP: 77,
  HOSTILE_ATTACK: 76, HOSTILE_GRID: 73, HOSTILE_SCAN: 71, HOSTILES: 70, HOSTILE_INBOUND: 69, SYSTEM_DANGER: 60,
  MISSION_EXPIRING: 50,
  SHIP_CHANGE: 40, SKILL_DONE: 35, JOB_READY: 35, ORDER_FILLED: 35, UNDOCK: 30, DOCK: 30, SILENCE: 10,
  ...TRIGGER_PRIORITY });
const PRE_HTTP_REASONS = Object.freeze(["DISABLED", "BREAKER", "RATE", "BUDGET", "CHAR_BUDGET", "LANE_BUDGET",
  "BAD_INPUT", "CONTEXT"]);
const LINE_KINDS = Object.freeze(Object.keys(PRIORITY));
const LOSSES_PER_IDENTITY = 4;
const MAX_NAME_CHARS = 60;
const MS_PER_MINUTE = 60000;
const COUNTER_NAMES = Object.freeze(["passes", "skippedGovernor", "watched", "telemetryReads", "events", "lines",
  "staticLines", "modelRequests", "modelLines", "fallbacks", "lossesNoted", "lossesDuplicate", "lossesDropped",
  "clonesOwed", "sqlFailed", "mentioned", "droppedQuiet",
  "briefs", "briefFailed", "toolLines",
  "watchOffered", "watchDropped", "watchLines", "limitRefunded",
  "callouts", "calloutAttack", "calloutGrid", "calloutSystem", "calloutSuppressed", "calloutSensorFailed",
  "calloutScanTruncated",
  "alertCommands", "alertsSkipped",
  "calloutInbound",
  "calloutWave",
  "calloutOfferStale",
  "wingReads", "wingSensorFailed", "wingScanTruncated", "wingCopiesCapped", "wingHpLines", "wingHpEntries", "wingHpSuppressed",
  "wingHpDropped", "wingLossLines", "wingLossDuplicate",
  "wingCopiesSeen", "wingHpCarried", "wingHpAged",
  "triggerReads", "triggerSensorFailed", "triggerLines", "triggerSuppressed", "triggerDropped", "triggerMuted",
  "triggerDuplicate", "muteCommands",
  "activityFacts", "activityDropped", "activityLines", "activitySuppressed", "notableMiss", "siteDuplicate",
  "welcomePlanned", "welcomeLines", "welcomeExpired", "seenWrites", "seenWriteFailed",
  "worldViews", "worldDropped", "worldOutOfRange", "worldSystemCooldown", "worldNoGraph", "worldLines", "hereReads",
  "hereFailed", "hereLiveSkipped", "hereLines",
  "abyssalReads", "abyssalFailed", "abyssalLines"]);
const CALLOUT_KIND = Object.freeze({ attack: "HOSTILE_ATTACK", grid: "HOSTILE_GRID", scan: "HOSTILE_SCAN",
  system: "HOSTILES", inbound: "HOSTILE_INBOUND" });
const CALLOUT_KEY = Object.freeze({ attack: "attack", grid: "grid", scan: "scan", system: "hostiles",
  inbound: "inbound" });
const CALLOUT_COUNTER = Object.freeze({ attack: "calloutAttack", grid: "calloutGrid", system: "calloutSystem",
  inbound: "calloutInbound" });
const CALLOUT = "callout";
const WING = "wing";
const MARKS_SHIP_WING = "shipWing";
const MARKS_CONFIG = "config";
const OWN_LEVELS = Object.freeze(["attack", "grid", "system", "inbound"]);
const DOCKED_EMPTY_LEVELS = Object.freeze(["attack", "grid", "system"]);
const INBOUND_OFF_REASONS = Object.freeze(["TRANSIT_OFF", "UNAVAILABLE", "SEAM_UNAVAILABLE"]);
const TRIGGER = "trigger";
const TYPE_CACHE_MAX = 512;
const WORLD_KEY_PREFIX = "world:";
const ATTACK_RANGE_FACTOR = 2;

function noop() {}

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const codeOf = (value) => String(value ?? "unknown").replace(/[^\w:.\-]/g, "_").slice(0, 60);
const valueOf = (res) => (res && res.ok && res.value && res.value.ok ? res.value : null);
const nameText = (v) => {
  const t = sanitizeGameText(v, MAX_NAME_CHARS);
  return t === "" ? null : t;
};

function isLowHp(view, S) {
  if (!view || view.state !== "space") return false;
  const low = (v) => Number.isSafeInteger(v) && v < S.lowHpPermille;
  return low(view.armorPermille) || low(view.structurePermille);
}

function globalOkOf(lastProactiveAt, nowMs, S) {
  return lastProactiveAt === null || lastProactiveAt === undefined
    || nowMs - lastProactiveAt >= S.proactiveMinIntervalMs;
}

const toolsOnOf = (S) => S.proactiveToolsEnabled === true && S.toolMode !== "off";
function hintOf(kind, S) {
  const byName = toolMapFor(S);
  return (TOOL_HINTS[kind] || []).filter((name) => byName.has(name));
}

function planProactive(prev, next, prefs, nowMs, S) {
  const p = prefs || {};
  if (!prev || !next || p.quiet === true) return [];
  const last = p.lastByKind instanceof Map ? p.lastByKind : new Map();
  const since = (kind) => (last.has(kind) ? nowMs - last.get(kind) : Infinity);
  const globalOk = globalOkOf(p.lastProactiveAt, nowMs, S);
  const kinds = new Set(detectEvents(prev, next, nowMs).map((e) => e.kind));
  const out = [];
  const add = (kind, line) => out.push({ kind, line, priority: PRIORITY[kind] });
  if (next.clonePending === true) add("LOSS_POD", MODEL);
  if (next.shipLost === true) add("LOSS_SHIP", MODEL);
  if (next.lowHp === true && since("LOW_HP") >= S.lowHpCooldownMs) add("LOW_HP", STATIC);
  for (const kind of ["HOSTILES", "SYSTEM_DANGER"]) {
    if (kind === "HOSTILES" && (S.calloutEnabled === true || p.alertsOff === true)) continue;
    if (kinds.has(kind) && since(kind) >= S.proactiveKindCooldownMs) add(kind, STATIC);
  }
  if (globalOk) {
    for (const kind of ["SHIP_CHANGE", "UNDOCK", "DOCK"]) {
      if (kinds.has(kind) && since(kind) >= S.proactiveKindCooldownMs) add(kind, MODEL);
    }
    if (S.silenceMs > 0 && next.roomOpen === true && Number.isFinite(next.lastSpokeAt)
      && nowMs - next.lastSpokeAt >= S.silenceMs && since("SILENCE") >= S.proactiveMinIntervalMs) {
      add("SILENCE", MODEL);
    }
    const watch = Array.isArray(next.watchPending) ? next.watchPending.filter((k) => WATCH_KINDS.includes(k)) : [];
    if (watch.length > 0) {
      const top = watch.reduce((a, b) => (PRIORITY[b] > PRIORITY[a] ? b : a));
      out.push({ kind: top, line: MODEL, priority: PRIORITY[top], watch: true });
    }
    if (S.triggersEnabled === true && S.regionLineEnabled === true && kinds.has("REGION_ENTER")
      && typeof next.regionName === "string" && next.regionName.trim() !== ""
      && since("REGION_ENTER") >= S.proactiveKindCooldownMs) {
      add("REGION_ENTER", MODEL);
    }
  }
  if (next.welcome === true) add("WELCOME_BACK", globalOk ? MODEL : STATIC);
  const top = next.triggerTop;
  if (top && typeof top.kind === "string" && Number.isFinite(PRIORITY[top.kind])) {
    out.push({ kind: top.kind, line: top.model === true && globalOk ? MODEL : TRIGGER, priority: PRIORITY[top.kind],
      trigger: top });
  }
  const dockDamaged = Boolean(top) && top.kind === "DOCK_DAMAGED";
  const muted = p.muted instanceof Set ? p.muted : null;
  return out.filter((e) => !(dockDamaged && e.kind === "DOCK") && !(muted && muted.has(e.kind)))
    .sort((a, b) => b.priority - a.priority);
}

function createProactive(deps) {
  const d = deps;
  const S = d.S;
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : { log: noop };
  const telemetry = d.telemetry && typeof d.telemetry.count === "function" ? d.telemetry : null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const byKind = Object.fromEntries(LINE_KINDS.map((k) => [k, 0]));
  const enabled = S.proactiveEnabled === true;
  const prefs = new Map(d.initialPrefs instanceof Map ? d.initialPrefs : []);
  const lastByKind = new Map();
  const lastSpokeAt = new Map();
  const offered = new Map();
  const watchPending = new Map();
  const calloutState = new Map();
  const calloutOffers = new Map();
  const calloutDiag = new Map();
  const typeClass = new Map();
  let inboundOffLogged = false;
  const calloutOn = enabled && S.calloutEnabled === true;
  const wingState = new Map();
  const wingLosses = new Map();
  const wingSeenLoss = new Set();
  let wingLive = false;
  let wingMarks = null;
  let wingMarksAt = null;
  const wingLogged = new Set();
  let wingStatsAt = null;
  let wingStatsBase = null;
  const triggerState = new Map();
  const triggersLive = enabled && S.triggersEnabled === true;
  let crimeStatus = triggersLive && S.crimeWatchEnabled === true ? "on" : "off";
  const triggerLogged = new Set();
  const globalMuted = new Set(String(S.triggersDisabledKinds || "").split(",").map((k) => k.trim().toUpperCase())
    .filter((k) => MUTE_KINDS.includes(k)));
  const mutedSets = new Map();
  const activityQueue = [];
  const activityMax = Math.max(1, d.maxIdentities * Math.max(1, S.triggerQueueMax || 1));
  const notableClasses = parseNameList(S.notableKillClasses) || [];
  const notablePatterns = parseNameList(S.notableKillNamePatterns) || [];
  const activityStatus = { mining: "off", site: "off", kills: "off" };
  const killLabels = new Map();
  const seenState = new Map();
  const welcomeDue = new Map();
  const welcomeLive = enabled && S.welcomeEnabled === true && Boolean(d.prefsRepo)
    && typeof d.prefsRepo.setLastSeen === "function";
  const worldQueue = [];
  const worldMax = activityMax;
  const worldKinds = parseWorldKinds(S.worldNewsKinds) || null;
  let worldSeam = "off";
  let worldUnsubscribe = null;
  const hereState = new Map();
  const hereCache = new Map();
  const worldTold = new Map();
  const toldPerPlayer = Math.max(1, S.triggerQueueMax || 1);
  const toldPlayers = Number.isSafeInteger(d.maxIdentities) && d.maxIdentities > 0 ? d.maxIdentities : 1;
  const hereLive = triggersLive && (S.battleHereEnabled === true || S.eventHereEnabled === true);
  const abyssalLive = triggersLive && S.abyssalLinesEnabled === true;
  const abyssalSettings = Object.freeze({ abyssalWarnAtMs: parseWarnList(S.abyssalWarnAtMs) || [],
    abyssalSeenMax: S.abyssalSeenMax, language: S.language });
  const abyssalState = new Map();
  let abyssalCache = null;
  const observer = createObserver();
  const lossQueue = [];
  const maxQueue = Math.max(1, d.maxIdentities * LOSSES_PER_IDENTITY);
  const clonePending = new Set();
  const shipLost = new Set();
  let removeListener = null;
  let lossSeam = "off";
  let inflight = false;
  let stopped = false;
  let generation = 0;
  let lineSeq = 0;

  const log = (line) => {
    try {
      logger.log(line);
    } catch (_err) {
    }
  };
  const metric = () => {
    if (!telemetry) return;
    try {
      telemetry.count(METRIC.proactive, 1);
    } catch (_err) {
    }
  };
  const governorAdmits = () => {
    try {
      const g = typeof d.getGovernor === "function" ? d.getGovernor() : null;
      return !g || typeof g.admits !== "function" || g.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  };
  const tx = (name, fn) => {
    const res = d.store.transaction(name, fn);
    const v = valueOf(res);
    if (!v) {
      counters.sqlFailed += 1;
      log(`shipAi proactive: ${name} failed - ${codeOf(res && (res.ok ? res.value && res.value.reason : res.reason))}`);
    }
    return v;
  };
  const prefsOf = (playerId) => prefs.get(playerId)
    || { quiet: false, lastProactiveAt: null, calloutMode: "on", dscanMode: "on" };
  const alertsOffOf = (playerId) => prefsOf(playerId).calloutMode === "off";
  const mutedOf = (playerId) => {
    let set = mutedSets.get(playerId);
    if (!set) {
      const own = prefsOf(playerId).mutedKinds;
      set = new Set([...globalMuted, ...(Array.isArray(own) ? own.filter((k) => MUTE_KINDS.includes(k)) : [])]);
      mutedSets.set(playerId, set);
    }
    return set;
  };
  const kindsOf = (playerId) => {
    let m = lastByKind.get(playerId);
    if (!m) {
      m = new Map();
      lastByKind.set(playerId, m);
    }
    return m;
  };

  function typeLabel(typeId) {
    const name = nameText(d.toolDeps.typeName(typeId));
    if (!name) return { name: null, cls: null };
    const r = d.toolDeps.itemByName(name);
    return { name, cls: r && r.ok && r.found && r.item ? nameText(r.item.groupName) : null };
  }

  function noteLoss(facts) {
    try {
      if (stopped || !facts || !isId(facts.victimCharacterId) || !d.isWatched(facts.victimCharacterId)) return;
      if (facts.copy === true) {
        noteCopyLoss(facts);
        return;
      }
      if (lossQueue.length >= maxQueue) {
        counters.lossesDropped += 1;
        return;
      }
      lossQueue.push({ playerId: facts.victimCharacterId, typeId: facts.shipTypeId, killId: facts.killId,
        itemId: facts.itemId, systemId: facts.systemId, at: d.nowMs() });
      poller.arm(0);
    } catch (_err) {
    }
  }

  function noteCopyLoss(facts) {
    const playerId = facts.victimCharacterId;
    if (!wingLive) return;
    if (isId(facts.itemId)) forgetCopy(wingState.get(playerId) || null, facts.itemId);
    if (S.wingLossLineEnabled !== true || prefsOf(playerId).quiet) return;
    const lossMuted = mutedOf(playerId).has("WING_LOSS");
    if (isId(facts.itemId)) {
      if (wingSeenLoss.has(facts.itemId)) {
        counters.wingLossDuplicate += 1;
        return;
      }
      wingSeenLoss.add(facts.itemId);
    }
    if (lossMuted) return;
    const list = wingLosses.get(playerId) || [];
    if (list.length < S.wingHpMaxPerLine) {
      list.push({ name: typeof facts.copyName === "string" ? facts.copyName : null,
        typeId: isId(facts.shipTypeId) ? facts.shipTypeId : null });
    }
    wingLosses.set(playerId, list);
    poller.arm(0);
  }

  function noteActivityFact(fact) {
    try {
      if (stopped || !fact || !isId(fact.characterId) || !d.isWatched(fact.characterId)
        || prefsOf(fact.characterId).quiet) return;
      if (activityQueue.length >= activityMax) {
        counters.activityDropped += 1;
        return;
      }
      activityQueue.push({ ...fact, atMs: d.nowMs() });
      counters.activityFacts += 1;
      poller.arm(0);
    } catch (_err) {
    }
  }
  const noteMiningStop = (fact) => noteActivityFact(fact && { ...fact, type: "mining" });
  const noteSiteCleared = (fact) => noteActivityFact(fact && { ...fact, type: "site" });
  const noteKill = (fact) => noteActivityFact(fact && { ...fact, type: "kill" });

  function drainActivity() {
    const byPlayer = new Map();
    for (const f of activityQueue.splice(0, activityQueue.length)) {
      const list = byPlayer.get(f.characterId) || [];
      list.push(f);
      byPlayer.set(f.characterId, list);
    }
    return byPlayer;
  }

  function onWorldViews(views) {
    try {
      if (stopped || !Array.isArray(views)) return;
      let added = 0;
      for (const v of views) {
        if (!v || typeof v.kind !== "string" || (worldKinds && !worldKinds.has(v.kind))) continue;
        if (worldQueue.length >= worldMax) {
          counters.worldDropped += 1;
          continue;
        }
        worldQueue.push(v);
        counters.worldViews += 1;
        added += 1;
      }
      if (added > 0) poller.arm(0);
    } catch (_err) {
    }
  }

  function drainWorld(players, now) {
    const views = worldQueue.splice(0, worldQueue.length);
    if (views.length === 0 || players.size === 0) return new Map();
    const graph = callDep("graph") || null;
    const memo = new Map();
    const within = (systemId) => {
      if (!graph) return null;
      if (!memo.has(systemId)) memo.set(systemId, systemsWithin(graph, systemId, S.worldNewsRadiusJumps));
      return memo.get(systemId);
    };
    const r = worldEntriesOf(views, players, within, triggerState, now, Object.assign(Object.create(S),
      { worldKinds }));
    counters.worldOutOfRange += r.outOfRange;
    counters.worldSystemCooldown += r.systemCooldown;
    counters.worldNoGraph += r.noGraph;
    return r.byPlayer;
  }

  function hereStep(rec, view, now) {
    if (!hereLive || rec.state !== "space") return [];
    const playerId = rec.characterId;
    const systemId = rec.systemId;
    let cached = hereCache.get(systemId);
    if (!cached || now - cached.at >= S.worldHereScanMs) {
      const r = callDep("hereIn", systemId, S.toolMaxRows);
      if (r === undefined) return [];
      counters.hereReads += 1;
      let reading = null;
      if (r && r.ok === true) {
        reading = { battles: S.battleHereEnabled === true ? r.battles : null,
          events: S.eventHereEnabled === true ? r.events : null };
      } else {
        counters.hereFailed += 1;
        triggerLogOnce("hereIn refused", codeOf(r && r.reason));
      }
      cached = { at: now, reading };
      hereCache.set(systemId, cached);
    }
    if (!cached.reading) return [];
    const planned = planHere(hereState.get(playerId) || null, cached.reading, view.systemName || null, now, S);
    hereState.set(playerId, planned.state);
    counters.hereLiveSkipped += planned.liveSkipped;
    return planned.entries;
  }

  function abyssalStep(rec, now) {
    if (!abyssalLive) return [];
    if (!abyssalCache || now - abyssalCache.at >= S.abyssalScanMs) {
      const r = callDep("abyssalRuns", now);
      if (r === undefined) return [];
      counters.abyssalReads += 1;
      let runs = null;
      if (r && r.ok === true && Array.isArray(r.runs)) {
        runs = r.runs;
      } else {
        counters.abyssalFailed += 1;
        triggerLogOnce("abyssalRuns refused", codeOf(r && r.reason));
      }
      abyssalCache = { at: now, runs };
    }
    if (!abyssalCache.runs) return [];
    const playerId = rec.characterId;
    const planned = planAbyssal(abyssalState.get(playerId) || null, { runs: abyssalCache.runs }, playerId, now,
      abyssalSettings);
    abyssalState.set(playerId, planned.state);
    return planned.entries;
  }

  function worldNewsCovers(playerId) {
    return worldSeam === "on" && !stopped && !mutedOf(playerId).has("WORLD_NEWS") && !prefsOf(playerId).quiet;
  }

  function rememberTold(playerId, entryKey, now) {
    if (!isId(playerId) || typeof entryKey !== "string" || !entryKey.startsWith(WORLD_KEY_PREFIX)) return;
    const eventKey = entryKey.slice(WORLD_KEY_PREFIX.length);
    const keys = worldTold.get(playerId) || new Map();
    worldTold.delete(playerId);
    keys.delete(eventKey);
    keys.set(eventKey, now);
    while (keys.size > toldPerPlayer) keys.delete(keys.keys().next().value);
    worldTold.set(playerId, keys);
    while (worldTold.size > toldPlayers) worldTold.delete(worldTold.keys().next().value);
  }

  function worldNewsToldMail(playerId, messageId) {
    try {
      const told = worldTold.get(playerId);
      if (stopped || !told || told.size === 0 || !isId(messageId)) return false;
      const n = typeof d.getNotices === "function" ? d.getNotices() : null;
      const r = n && typeof n.mailEventKeys === "function" ? n.mailEventKeys(playerId, messageId) : null;
      if (!r || r.ok !== true || !Array.isArray(r.eventKeys) || r.eventKeys.length === 0) return false;
      return r.eventKeys.every((k) => told.has(k));
    } catch (_err) {
      return false;
    }
  }

  function killLabelOf(typeId) {
    if (!isId(typeId)) return { name: null, cls: null };
    if (killLabels.has(typeId)) return killLabels.get(typeId);
    if (killLabels.size >= TYPE_CACHE_MAX) killLabels.clear();
    let label;
    try {
      label = typeLabel(typeId);
    } catch (_err) {
      label = { name: null, cls: null };
    }
    killLabels.set(typeId, label);
    return label;
  }

  function writeLosses() {
    if (lossQueue.length === 0) return;
    const batch = lossQueue.splice(0, lossQueue.length);
    const index = d.staticIndex();
    const specs = [];
    for (const l of batch) {
      const id = isId(l.killId) ? l.killId : l.itemId;
      if (!isId(id)) continue;
      const pod = isCapsule(l.typeId);
      const sys = index && isId(l.systemId) ? index.get(l.systemId) : null;
      specs.push({ playerId: l.playerId, pod, spec: { playerId: l.playerId, kind: pod ? "LOSS_POD" : "LOSS_SHIP",
        key: `loss:${id}`, nowMs: l.at, payload: { ship: isId(l.typeId) ? typeLabel(l.typeId).name : null,
          system: sys ? sys.name : null } } });
    }
    const v = tx("shipAi.events.loss", (db) => {
      const inserted = [];
      for (const s of specs) {
        const r = d.eventsRepo.noteEventInTx(db, s.spec);
        if (!r.ok) return r;
        inserted.push(r.inserted);
      }
      return { ok: true, inserted };
    });
    if (!v) return;
    specs.forEach((s, i) => {
      if (!v.inserted[i]) {
        counters.lossesDuplicate += 1;
        return;
      }
      counters.lossesNoted += 1;
      counters.events += 1;
      if (s.pod) clonePending.add(s.playerId);
      else if (!prefsOf(s.playerId).quiet) shipLost.add(s.playerId);
    });
  }

  function viewOf(rec, prev, side) {
    const index = d.staticIndex();
    const sys = index ? index.get(rec.systemId) : null;
    counters.telemetryReads += 1;
    const t = d.toolDeps.telemetry(rec.characterId);
    const view = { systemId: rec.systemId, state: rec.state,
      stable: rec.state === "docked" || rec.state === "space" ? rec.state : (prev ? prev.stable : null),
      secClass: sys ? sys.security : null, regionId: sys && isId(sys.regionId) ? sys.regionId : null,
      systemName: sys ? sys.name : null, regionName: sys ? sys.region : null,
      shipTypeId: prev ? prev.shipTypeId : null, shipName: prev ? prev.shipName : null,
      shipClass: prev ? prev.shipClass : null, armorPermille: null, structurePermille: null, hostilesHere: 0 };
    if (t && t.ok) {
      if (isId(t.shipTypeId) && t.shipTypeId !== view.shipTypeId) {
        const label = typeLabel(t.shipTypeId);
        Object.assign(view, { shipTypeId: t.shipTypeId, shipName: label.name, shipClass: label.cls });
      }
      if (t.docked !== true) {
        view.armorPermille = t.armorPermille;
        view.structurePermille = t.structurePermille;
      }
    }
    if (rec.state === "space") {
      const r = fleetsAround(d.toolDeps, rec.characterId, rec.systemId, 0);
      if (r.ok) view.hostilesHere = r.entries.filter((e) => e.hostility === "hostile").length;
      if (side) side.fleets = r.ok ? r.entries : null;
    }
    if (side) side.telemetry = t;
    view.lowHp = isLowHp(view, S);
    return view;
  }

  const callDep = (name, ...args) => {
    try {
      return typeof d.toolDeps[name] === "function" ? d.toolDeps[name](...args) : undefined;
    } catch (_err) {
      return null;
    }
  };

  function classOfType(typeId) {
    if (!isId(typeId)) return null;
    if (typeClass.has(typeId)) return typeClass.get(typeId);
    if (typeClass.size >= TYPE_CACHE_MAX) typeClass.clear();
    let key = null;
    try {
      key = classKeyOf(typeLabel(typeId).cls);
    } catch (_err) {
      key = null;
    }
    typeClass.set(typeId, key);
    return key;
  }

  function factionNameOf(factionId) {
    if (!isId(factionId)) return null;
    const name = nameText(callDep("factionName", factionId));
    return name && name !== UNKNOWN.faction ? name : null;
  }

  function groupsOf(items) {
    const by = new Map();
    for (const it of items) {
      const key = `f:${isId(it.factionId) ? it.factionId : 0}`;
      const g = by.get(key) || { key, factionId: it.factionId, ships: 0, classes: new Set(), ids: [] };
      g.ships += it.ships;
      g.classes.add(it.cls === undefined ? null : it.cls);
      if (isId(it.entityId)) g.ids.push(it.entityId);
      by.set(key, g);
    }
    return [...by.values()].sort((a, b) => b.ships - a.ships || (a.key < b.key ? -1 : 1)).map((g) => ({ key: g.key,
      faction: factionNameOf(g.factionId), ships: g.ships, cls: g.classes.size === 1 ? [...g.classes][0] : null,
      ...(g.ids.length > 0 ? { ids: g.ids } : {}) }));
  }

  function gridOf(systemId, cache) {
    if (cache.has(systemId)) return cache.get(systemId);
    let r = callDep("gridNpcs", systemId, { maxScan: S.calloutScanMax });
    if (r === undefined) r = null;
    else if (!r || r.ok !== true || !Array.isArray(r.npcs)) {
      counters.calloutSensorFailed += 1;
      r = null;
    } else if (r.truncated === true) {
      counters.calloutScanTruncated += 1;
    }
    cache.set(systemId, r);
    return r;
  }

  function inboundOf(systemId, cache, now) {
    if (cache.has(systemId)) return cache.get(systemId);
    let r = callDep("inboundFleets", systemId, now);
    if (r === undefined) {
      r = null;
    } else if (r && r.ok === true && Array.isArray(r.fleets)) {
    } else if (r && INBOUND_OFF_REASONS.includes(r.reason)) {
      if (!inboundOffLogged) {
        inboundOffLogged = true;
        log(`shipAi proactive: inbound off - ${codeOf(r.reason)}`);
      }
      r = null;
    } else {
      counters.calloutSensorFailed += 1;
      r = null;
    }
    cache.set(systemId, r);
    return r;
  }

  function calloutPass(rec, side, now, caches) {
    const playerId = rec.characterId;
    const readings = [];
    let hostileOf = null;
    const hostile = (factionId) => {
      if (hostileOf === null) {
        const pirates = callDep("pirates");
        const invaders = callDep("invaderFactions", now);
        const standings = new Map();
        const standing = (id) => {
          if (!standings.has(id)) {
            const v = callDep("standing", playerId, id);
            standings.set(id, typeof v === "number" ? v : null);
          }
          return standings.get(id);
        };
        const ctx = { pirates: pirates instanceof Set ? pirates : null,
          invaders: invaders instanceof Set ? invaders : null, standing };
        hostileOf = (id) => isHostileFaction(id, ctx, S);
      }
      return hostileOf(factionId);
    };
    let reset = false;
    let position = null;
    if (rec.state === "docked") {
      reset = true;
      for (const level of DOCKED_EMPTY_LEVELS) readings.push({ level, groups: [] });
    } else if (rec.state === "space") {
      if (Array.isArray(side.fleets)) {
        const ships = side.fleets.filter((e) => e && isId(e.ships) && hostile(e.factionId))
          .map((e) => ({ factionId: e.factionId, ships: e.ships, cls: null }));
        readings.push({ level: "system", groups: groupsOf(ships) });
      } else if (side.fleets === null) {
        counters.calloutSensorFailed += 1;
      }
      const t = side.telemetry;
      if (t && t.ok && t.docked !== true && t.warping === true) reset = true;
      const pos = t && t.ok && t.docked !== true && t.warping !== true ? t.position : null;
      if (pos) position = pos;
      const grid = pos && isId(t.entityId) ? gridOf(rec.systemId, caches.grid) : null;
      if (grid) {
        const range = S.calloutGridRangeMeters;
        const inGrid = [];
        const attackers = [];
        let nearest = null;
        const diag = { atMs: now, npcs: grid.npcs.length, inRange: 0, hostile: 0, noFaction: 0 };
        for (const npc of grid.npcs) {
          if (!npc || npc.inWarp === true || !npc.position) continue;
          const dist = Math.hypot(npc.position.x - pos.x, npc.position.y - pos.y, npc.position.z - pos.z);
          if (!Number.isFinite(dist)) continue;
          const attacking = npc.targetId === t.entityId && dist <= ATTACK_RANGE_FACTOR * range;
          const item = { factionId: isId(npc.factionId) ? npc.factionId : 0, ships: 1, cls: classOfType(npc.typeId),
            entityId: npc.entityId };
          if (attacking) attackers.push(item);
          if (dist <= range) {
            diag.inRange += 1;
            if (!isId(npc.factionId)) diag.noFaction += 1;
          }
          if (dist <= range && (attacking || hostile(npc.factionId))) {
            inGrid.push(item);
            diag.hostile += 1;
            nearest = nearest === null ? dist : Math.min(nearest, dist);
          }
        }
        calloutDiag.set(playerId, diag);
        readings.push({ level: "attack", groups: groupsOf(attackers) });
        readings.push({ level: "grid", groups: groupsOf(inGrid), nearest });
      }
    }
    if ((rec.state === "docked" || rec.state === "space") && S.calloutInboundEnabled === true) {
      const inbound = inboundOf(rec.systemId, caches.inbound, now);
      if (inbound) {
        readings.push({ level: "inbound", groups: groupsOf(inbound.fleets
          .filter((f) => f && isId(f.ships) && hostile(f.factionId))
          .map((f) => ({ factionId: f.factionId, ships: f.ships, cls: null }))) });
      }
    }
    const offers = calloutOffers.get(playerId);
    if (offers) {
      calloutOffers.delete(playerId);
      for (const [level, r] of offers) {
        if (isId(r.systemId) && r.systemId !== rec.systemId) {
          counters.calloutOfferStale += 1;
          continue;
        }
        if (!readings.some((x) => x.level === level)) readings.push(r);
      }
    }
    return { systemId: rec.systemId, readings, position, reset };
  }

  function calloutEvent(line, view, now) {
    return { kind: "HOSTILES", key: `${CALLOUT_KEY[line.level]}:${view.systemId}:${Math.floor(now / MS_PER_MINUTE)}`,
      payload: { level: line.level, ships: line.ships, pilots: line.pilots,
        factions: line.groups.map((g) => g.faction).filter((f) => typeof f === "string").slice(0, 2),
        cls: line.groups.length > 0 && line.groups.every((g) => g.cls === line.groups[0].cls) ? line.groups[0].cls
          : null, system: view.systemName || null } };
  }

  const personaOf = (playerId) => (typeof d.personaOf === "function" ? d.personaOf(playerId) : null);

  function staticOut(playerId, kind, values) {
    lineSeq += 1;
    const p = personaOf(playerId);
    const text = staticLineWith(kind, S.language, playerId + lineSeq, values || null, p ? p.preset : undefined);
    if (text === "") return;
    counters.staticLines += 1;
    d.deliver(playerId, [text]);
  }

  function eventData(kind, event) {
    const out = { kind };
    if (event && event.payload) {
      for (const [k, v] of Object.entries(event.payload)) {
        if (typeof v === "string") out[k] = sanitizeGameText(v, MAX_NAME_CHARS);
        else if (Number.isSafeInteger(v)) out[k] = v;
      }
    }
    return out;
  }

  function watchData(picked, withTools, now) {
    const minutes = (ms) => Math.max(0, Math.floor(ms / MS_PER_MINUTE));
    const events = picked.map((e) => {
      const out = { ...eventData(e.kind, e), minutesAgo: minutes(now - e.occurredAt) };
      if (Number.isSafeInteger(e.expiresAt)) out.minutesLeft = minutes(e.expiresAt - now);
      return out;
    });
    if (!withTools) return { kind: "WATCH", events };
    const hint = [];
    for (const e of picked) for (const name of hintOf(e.kind, S)) if (!hint.includes(name)) hint.push(name);
    return { kind: "WATCH", events, hint };
  }

  function modelOut(playerId, kind, event, opts) {
    const brief = Boolean(opts) && opts.brief === true;
    const picked = opts && Array.isArray(opts.watch) ? opts.watch : null;
    const refund = opts && typeof opts.refund === "function" ? opts.refund : noop;
    const first = picked && picked.length > 0 ? picked[0] : null;
    const own = opts && opts.fallback ? opts.fallback : null;
    const fallbackKind = first ? watchTemplateOf(first) : (own ? own.kind : kind);
    const fallbackValues = first ? watchValuesOf(first, S.language)
      : (own ? own.values : (event && event.payload ? event.payload : null));
    if (inflight) {
      if (brief) return;
      counters.fallbacks += 1;
      staticOut(playerId, fallbackKind, fallbackValues);
      return;
    }
    inflight = true;
    counters.modelRequests += 1;
    const gen = generation;
    const withTools = toolsOnOf(S);
    let promise;
    try {
      const snap = d.snapshot(playerId);
      const playerName = snap && snap.presence ? snap.presence.name : null;
      const ev = picked ? watchData(picked, withTools, d.nowMs())
        : (withTools ? { ...eventData(kind, event), hint: hintOf(kind, S) } : eventData(kind, event));
      const p = personaOf(playerId);
      const messages = [
        { role: "system", content: buildSystemPrompt({ aiName: d.nameOf(playerId), playerName, language: S.language,
          maxLines: S.maxLinesPerReply, preset: p ? p.preset : undefined, custom: p ? p.custom : null,
          profanity: S.profanity, customMaxChars: S.personaCustomMaxChars }) },
        { role: "system", content: `DATA {"snapshot":${snap && typeof snap.json === "string" ? snap.json : "{}"},`
          + `"event":${JSON.stringify(ev)}}` },
        { role: "system", content: withTools ? PROACTIVE_TOOL_RULE : PROACTIVE_RULE },
        { role: "user", content: PROACTIVE_USER },
      ];
      promise = Promise.resolve(d.client.request({ playerId, messages, lane: LANE, maxTokens: S.maxTokens,
        ...(withTools ? { tools: true } : {}) }));
    } catch (_err) {
      promise = Promise.resolve({ ok: false, reason: "CONTEXT" });
    }
    const settle = (res) => {
      if (stopped || gen !== generation) return;
      inflight = false;
      const preHttp = Boolean(res) && res.ok !== true && PRE_HTTP_REASONS.includes(res.reason);
      const giveBack = () => {
        if (!preHttp) return;
        try {
          refund();
        } catch (err) {
          log(`shipAi proactive: refund failed - ${codeOf(err && (err.code || err.name))}`);
        }
      };
      if (prefsOf(playerId).quiet) {
        counters.droppedQuiet += 1;
        giveBack();
        return;
      }
      try {
        const filtered = res && res.ok === true ? filterReply(res.text, S, S.language) : null;
        if (filtered && filtered.ok) {
          counters.modelLines += 1;
          if (withTools) counters.toolLines += 1;
          if (picked) counters.watchLines += 1;
          d.deliver(playerId, filtered.lines);
          return;
        }
        if (brief) {
          counters.briefFailed += 1;
          giveBack();
          return;
        }
        counters.fallbacks += 1;
        staticOut(playerId, fallbackKind, fallbackValues);
      } catch (err) {
        log(`shipAi proactive: line failed - ${codeOf(err && (err.code || err.name))}`);
      }
    };
    promise.then(settle, () => settle({ ok: false, reason: "NET_ERROR" }));
  }

  function takeLimit(playerId, now) {
    const before = prefsOf(playerId).lastProactiveAt;
    prefs.set(playerId, { ...prefsOf(playerId), lastProactiveAt: now });
    tx("shipAi.prefs.proactive", (db) => d.prefsRepo.setLastProactive(db, { playerId, atMs: now }));
    return () => {
      if (prefsOf(playerId).lastProactiveAt !== now) return;
      const prev = before === undefined ? null : before;
      prefs.set(playerId, { ...prefsOf(playerId), lastProactiveAt: prev });
      tx("shipAi.prefs.proactive", (db) => d.prefsRepo.setLastProactive(db, { playerId, atMs: prev }));
      counters.limitRefunded += 1;
    };
  }

  function pruneWatch(playerId, now) {
    const pend = watchPending.get(playerId);
    if (!pend) return [];
    for (const [key, e] of pend) {
      if (now - e.notedAt > S.watchPendingMaxAgeMs || (e.expiresAt !== null && e.expiresAt <= now)) {
        pend.delete(key);
        counters.watchDropped += 1;
      }
    }
    if (pend.size === 0) {
      watchPending.delete(playerId);
      return [];
    }
    return [...pend.values()].map((e) => e.kind);
  }

  function speakWatch(playerId, now) {
    const pend = watchPending.get(playerId);
    if (!pend) return;
    const picked = [...pend.values()].sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind] || a.occurredAt - b.occurredAt
      || (a.key < b.key ? -1 : 1)).slice(0, S.watchMaxPerLine);
    for (const e of picked) pend.delete(e.key);
    if (pend.size === 0) watchPending.delete(playerId);
    const marked = tx("shipAi.events.mention", (db) => {
      let changed = 0;
      for (const e of picked) {
        const r = d.eventsRepo.markMentionedInTx(db, { playerId, key: e.key, atMs: now });
        if (!r.ok) return r;
        changed += r.changed;
      }
      return { ok: true, changed };
    });
    if (!marked) {
      const back = watchPending.get(playerId) || new Map();
      for (const e of picked) back.set(e.key, e);
      watchPending.set(playerId, back);
      return;
    }
    counters.mentioned += marked.changed;
    const kind = picked[0].kind;
    kindsOf(playerId).set(kind, now);
    lastSpokeAt.set(playerId, now);
    counters.lines += 1;
    byKind[kind] += 1;
    metric();
    const refund = takeLimit(playerId, now);
    modelOut(playerId, kind, null, { watch: picked, refund });
  }

  function speak(playerId, top, events, now) {
    if (top.watch === true) {
      speakWatch(playerId, now);
      return;
    }
    if (top.line === CALLOUT) {
      calloutOut(playerId, top, now);
      return;
    }
    if (top.line === WING) {
      wingOut(playerId, top, now);
      return;
    }
    if (top.line === TRIGGER) {
      triggerOut(playerId, top, now);
      return;
    }
    kindsOf(playerId).set(top.kind, now);
    lastSpokeAt.set(playerId, now);
    counters.lines += 1;
    byKind[top.kind] += 1;
    metric();
    const event = events.find((e) => e.kind === top.kind) || null;
    const lossKind = top.kind === "LOSS_POD" || top.kind === "LOSS_SHIP";
    if (top.kind === "LOSS_POD") clonePending.delete(playerId);
    if (top.kind === "LOSS_SHIP") shipLost.delete(playerId);
    if (lossKind || event) {
      const marked = tx("shipAi.events.mention", (db) => d.eventsRepo.markMentionedInTx(db, lossKind
        ? { playerId, kind: top.kind, atMs: now } : { playerId, key: event.key, atMs: now }));
      if (marked) counters.mentioned += marked.changed;
    }
    if (top.line !== MODEL) {
      staticOut(playerId, top.kind);
      const p = prefsOf(playerId);
      if (top.kind === "SYSTEM_DANGER" && S.dangerBriefEnabled === true && toolsOnOf(S) && !inflight && !p.quiet
        && globalOkOf(p.lastProactiveAt, now, S)) {
        const refund = takeLimit(playerId, now);
        counters.briefs += 1;
        modelOut(playerId, top.kind, event, { brief: true, refund });
      }
      return;
    }
    const refund = takeLimit(playerId, now);
    const t = top.trigger;
    const fallback = t && typeof t.template === "string" && t.template !== ""
      ? { kind: t.template, values: t.values || null } : null;
    modelOut(playerId, top.kind, event, { refund, fallback });
  }

  function calloutOut(playerId, top, now) {
    const line = top.callout.line;
    kindsOf(playerId).set(top.kind, now);
    lastSpokeAt.set(playerId, now);
    counters.lines += 1;
    counters.staticLines += 1;
    counters.callouts += 1;
    if (CALLOUT_COUNTER[line.level]) counters[CALLOUT_COUNTER[line.level]] += 1;
    if (line.wave === true) counters.calloutWave += 1;
    byKind[top.kind] += 1;
    metric();
    const marked = tx("shipAi.events.mention", (db) => d.eventsRepo.markMentionedInTx(db, { playerId,
      key: top.callout.event.key, atMs: now }));
    if (marked) counters.mentioned += marked.changed;
    lineSeq += 1;
    const text = buildCallout(line, S.language, playerId + lineSeq, { maxChars: S.calloutMaxChars,
      maxNameChars: S.calloutMaxNameChars });
    if (text !== "") d.deliver(playerId, [text]);
  }

  const wingLogOnce = (what, code) => {
    const key = `${what}:${code}`;
    if (wingLogged.has(key)) return;
    wingLogged.add(key);
    log(`shipAi proactive: wing ${what} - ${code}`);
  };

  function marksOf(now) {
    if (wingMarks && wingMarksAt !== null && now - wingMarksAt < S.wingHpThresholdRefreshMs) return wingMarks;
    const own = { warnPct: S.wingHpWarnPct, criticalPct: S.wingHpCriticalPct, source: MARKS_CONFIG };
    let marks = own;
    if (S.wingHpThresholdSource === MARKS_SHIP_WING) {
      const r = callDep("wingHpMarks");
      if (r && r.ok === true && Number.isSafeInteger(r.warnPct) && Number.isSafeInteger(r.criticalPct)
        && r.criticalPct < r.warnPct) {
        marks = { warnPct: r.warnPct, criticalPct: r.criticalPct, source: MARKS_SHIP_WING };
      } else {
        wingLogOnce("marks fallback", codeOf(r && r.reason));
      }
    }
    wingMarks = marks;
    wingMarksAt = now;
    return marks;
  }

  function wingOf(systemId, cache) {
    if (cache.has(systemId)) return cache.get(systemId);
    counters.wingReads += 1;
    const r = callDep("wingCopies", systemId, { scanMax: S.wingHpScanMax });
    let out = null;
    if (r && r.ok === true && Array.isArray(r.copies)) {
      if (r.truncated === true) {
        counters.wingScanTruncated += 1;
        wingLogOnce("copies truncated", "SCAN_MAX");
      }
      out = new Map();
      for (const c of r.copies) {
        if (!c || !isId(c.ownerId) || !isId(c.entityId)) continue;
        const name = nameText(c.name) || (isId(c.typeId) ? typeLabel(c.typeId).name : null);
        const list = out.get(c.ownerId) || [];
        list.push({ entityId: c.entityId, typeId: c.typeId, name, hp: c.hp });
        out.set(c.ownerId, list);
      }
    } else {
      counters.wingSensorFailed += 1;
      wingLogOnce("copies refused", codeOf(r && r.reason));
    }
    cache.set(systemId, out);
    return out;
  }

  function wingStep(rec, side, now, caches, plan) {
    const playerId = rec.characterId;
    const losses = wingLosses.get(playerId);
    if (losses && losses.length > 0) {
      plan.push({ kind: "WING_LOSS", line: WING, priority: PRIORITY.WING_LOSS, wing: { losses: losses.slice() } });
    }
    const t = side.telemetry;
    if (rec.state === "docked" || (t && t.ok && t.docked === true)) {
      wingState.delete(playerId);
      return null;
    }
    if (rec.state !== "space" || (t && t.ok && t.warping === true)) return null;
    const copies = wingOf(rec.systemId, caches.wing);
    const before = wingState.get(playerId) || null;
    const mine = copies ? copies.get(playerId) || [] : null;
    if (mine !== null) counters.wingCopiesSeen += mine.length;
    if (!before && (mine === null || mine.length === 0)) return null;
    const planned = planWingHp(before, mine === null ? null : { ok: true, copies: mine }, marksOf(now), now, S);
    counters.wingHpSuppressed += planned.suppressed;
    counters.wingHpDropped += planned.dropped;
    counters.wingHpCarried += planned.carried;
    counters.wingHpAged += planned.aged;
    counters.wingCopiesCapped += planned.truncated > 0 ? 1 : 0;
    if (planned.state.copies.size === 0 && planned.state.pending.size === 0 && planned.state.left.size === 0) {
      wingState.delete(playerId);
      return null;
    }
    wingState.set(playerId, planned.state);
    const taken = takeWingLine(planned.state, now, S);
    if (!taken) return null;
    plan.push({ kind: "WING_HP", line: WING, priority: PRIORITY.WING_HP, wing: taken });
    return taken;
  }

  function wingOut(playerId, top, now) {
    kindsOf(playerId).set(top.kind, now);
    lastSpokeAt.set(playerId, now);
    counters.lines += 1;
    counters.staticLines += 1;
    byKind[top.kind] += 1;
    metric();
    lineSeq += 1;
    const opts = { maxChars: S.wingHpMaxChars, maxNameChars: S.wingHpMaxNameChars };
    let text = "";
    if (top.kind === "WING_LOSS") {
      wingLosses.delete(playerId);
      counters.wingLossLines += 1;
      const names = top.wing.losses.map((l) => nameText(l.name) || (isId(l.typeId) ? typeLabel(l.typeId).name : null));
      text = buildWingLossLine(names, S.language, playerId + lineSeq, opts);
    } else {
      counters.wingHpLines += 1;
      counters.wingHpEntries += top.wing.entries.length;
      text = buildWingHpLine(top.wing.entries, top.wing.more, S.language, playerId + lineSeq, opts);
    }
    if (text !== "") d.deliver(playerId, [text]);
  }

  const WING_STATS = Object.freeze([["reads", "wingReads"], ["failed", "wingSensorFailed"],
    ["scanTruncated", "wingScanTruncated"], ["capped", "wingCopiesCapped"], ["copies", "wingCopiesSeen"], ["lines", "wingHpLines"],
    ["entries", "wingHpEntries"], ["carried", "wingHpCarried"], ["suppressed", "wingHpSuppressed"],
    ["dropped", "wingHpDropped"], ["aged", "wingHpAged"], ["lost", "wingLossLines"]]);

  function wingStats(now) {
    if (!wingLive || !(S.wingHpStatsLogMs > 0)) return;
    const snap = () => Object.fromEntries(WING_STATS.map(([, k]) => [k, counters[k]]));
    if (wingStatsAt === null) {
      wingStatsAt = now;
      wingStatsBase = snap();
      return;
    }
    if (now - wingStatsAt < S.wingHpStatsLogMs) return;
    const cur = snap();
    if (cur.wingReads > wingStatsBase.wingReads) {
      log(`shipAi proactive: wing stats ${WING_STATS.map(([label, k]) => `${label}=${cur[k] - wingStatsBase[k]}`)
        .join(" ")}`);
    }
    wingStatsAt = now;
    wingStatsBase = cur;
  }

  const triggerLogOnce = (what, code) => {
    const key = `${what}:${code}`;
    if (triggerLogged.has(key)) return;
    triggerLogged.add(key);
    log(`shipAi proactive: trigger ${what} - ${code}`);
  };

  function triggerSensor(name, playerId) {
    const r = callDep(name, playerId);
    if (r === undefined) return null;
    if (r && r.ok === true) return r;
    counters.triggerSensorFailed += 1;
    const code = codeOf(r && r.reason);
    triggerLogOnce(`${name} refused`, code);
    if (name === "crimeFlags") crimeStatus = code;
    return null;
  }

  function triggerStep(rec, side, view, events, now, caches) {
    if (!triggersLive) return null;
    const playerId = rec.characterId;
    if (prefsOf(playerId).quiet) return null;
    counters.triggerReads += 1;
    let crime = null;
    if (S.crimeWatchEnabled === true) {
      crime = triggerSensor("crimeFlags", playerId);
      if (crime) crimeStatus = "on";
    }
    const sec = triggerSensor("securityStatus", playerId);
    const t = side.telemetry && side.telemetry.ok === true ? side.telemetry : null;
    const docked = rec.state === "docked" || Boolean(t && t.docked === true);
    const inSpace = rec.state === "space" && !docked;
    const dock = docked && t && events.some((e) => e.kind === "DOCK")
      ? { armorPermille: t.armorPermille, structurePermille: t.structurePermille } : null;
    const reading = { inSpace, docked, warping: t ? t.warping : null, capacitorPermille: t ? t.capacitorPermille : null,
      crime, securityStatus: sec && typeof sec.securityStatus === "number" ? sec.securityStatus : null, dock,
      systemId: rec.systemId, systemName: view.systemName || null };
    const settings = Object.assign(Object.create(S), { muted: mutedOf(playerId), notableClasses, notablePatterns });
    const planned = planTriggers(triggerState.get(playerId) || emptyTriggerState(), reading, now, settings);
    counters.triggerSuppressed += planned.suppressed;
    counters.triggerDropped += planned.dropped;
    counters.triggerMuted += planned.muted;
    let state = planned.state;
    const facts = caches && caches.activity ? caches.activity.get(playerId) : null;
    const entries = [];
    if (facts) {
      caches.activity.delete(playerId);
      const index = d.staticIndex();
      const names = { label: killLabelOf, faction: factionNameOf,
        system: (id) => (index && isId(id) && index.get(id) ? nameText(index.get(id).name) : null) };
      for (const f of facts) {
        const e = activityEntryOf(f, names, settings);
        if (e) entries.push(e);
        else if (f.type === "kill" && S.killLinesEnabled === true && f.navy !== true) counters.notableMiss += 1;
      }
    }
    const world = caches && caches.world ? caches.world.get(playerId) : null;
    if (world) {
      caches.world.delete(playerId);
      entries.push(...world);
    }
    entries.push(...hereStep(rec, view, now));
    entries.push(...abyssalStep(rec, now));
    if (facts || entries.length > 0) {
      const noted = noteActivity(state, entries, now, settings);
      counters.activitySuppressed += noted.suppressed;
      counters.triggerDropped += noted.dropped;
      counters.triggerMuted += noted.muted;
      state = noted.state;
    }
    triggerState.set(playerId, state);
    return takeTrigger(state);
  }

  function triggerEvent(entry) {
    const v = entry.values || {};
    const payload = { system: typeof v.system === "string" ? v.system : null };
    if (typeof v.threshold === "number") payload.threshold = v.threshold;
    if (typeof v.status === "number") payload.status = v.status;
    if (typeof v.layer === "string") payload.layer = v.layer;
    if (Number.isSafeInteger(v.pct)) payload.pct = v.pct;
    for (const k of ["siteKind", "faction", "name", "cls"]) if (typeof v[k] === "string") payload[k] = v[k];
    for (const k of ["notice", "attacker", "defender", "outcome", "a", "b", "label", "eventType"]) {
      if (typeof v[k] === "string") payload[k] = v[k];
    }
    if (Number.isSafeInteger(v.jumps)) payload.jumps = v.jumps;
    return { kind: entry.kind, key: entry.key, payload };
  }

  function triggerOut(playerId, top, now) {
    const entry = top.trigger;
    kindsOf(playerId).set(top.kind, now);
    lastSpokeAt.set(playerId, now);
    counters.lines += 1;
    counters.staticLines += 1;
    counters.triggerLines += 1;
    byKind[top.kind] += 1;
    metric();
    const marked = tx("shipAi.events.mention", (db) => d.eventsRepo.markMentionedInTx(db, { playerId, key: entry.key,
      atMs: now }));
    if (marked) counters.mentioned += marked.changed;
    lineSeq += 1;
    const lang = LAYER_NAMES[S.language] ? S.language : "en";
    const values = { ...entry.values };
    if (typeof values.layer === "string") values.layer = LAYER_NAMES[lang][values.layer] || "";
    const p = personaOf(playerId);
    const template = typeof entry.template === "string" && entry.template !== "" ? entry.template : top.kind;
    const text = staticLineWith(template, S.language, playerId + lineSeq, values, p ? p.preset : undefined);
    if (text !== "") d.deliver(playerId, [text]);
  }

  function welcomeReady(playerId, now) {
    const due = welcomeDue.get(playerId);
    if (!due) return false;
    if (now - due.at > S.welcomeMaxWaitMs) {
      welcomeDue.delete(playerId);
      counters.welcomeExpired += 1;
      return false;
    }
    return now - due.at >= S.watchLoginDelayMs;
  }

  function noteSeen(playerId, now, quiet, batch) {
    const st = seenState.get(playerId);
    if (!st) {
      const muted = mutedOf(playerId).has("WELCOME_BACK");
      const lastSeen = prefsOf(playerId).lastSeenAt;
      const decision = welcomeDecision(Number.isFinite(lastSeen) ? lastSeen : null, now, quiet || muted, S);
      if (decision.welcome) {
        welcomeDue.set(playerId, { at: now, hours: decision.hours });
        counters.welcomePlanned += 1;
      }
      seenState.set(playerId, { writtenAt: null });
      batch.push(playerId);
      return;
    }
    if (st.writtenAt === null || now - st.writtenAt >= S.welcomeSeenWriteMs) batch.push(playerId);
  }

  function writeSeen(batch, now) {
    if (batch.length === 0) return;
    const v = tx("shipAi.prefs.seen", (db) => {
      let changed = 0;
      for (const playerId of batch) {
        const r = d.prefsRepo.setLastSeen(db, { playerId, atMs: now });
        if (!r || !r.ok) return r || { ok: false, reason: "SEEN_FAILED" };
        changed += r.changed;
      }
      return { ok: true, changed };
    });
    if (!v) {
      counters.seenWriteFailed += 1;
      return;
    }
    counters.seenWrites += batch.length;
    for (const playerId of batch) {
      seenState.set(playerId, { writtenAt: now });
      prefs.set(playerId, { ...prefsOf(playerId), lastSeenAt: now });
    }
  }

  function observe(rec, now, caches) {
    const playerId = rec.characterId;
    const prev = observer.get(playerId);
    const side = {};
    const view = viewOf(rec, prev, side);
    if (!lastSpokeAt.has(playerId)) lastSpokeAt.set(playerId, now);
    observer.set(playerId, view);
    if (!prev) return;
    const p = prefsOf(playerId);
    const alertsOff = p.calloutMode === "off";
    const calloutLive = calloutOn && !alertsOff;
    if (calloutOn && alertsOff) counters.alertsSkipped += 1;
    const events = detectEvents(prev, view, now).filter((e) => !calloutLive || e.kind !== "HOSTILES");
    const roomOpen = Boolean(d.seam && d.seam.xmpp && typeof d.seam.xmpp.hasOpenRoom === "function"
      && d.seam.xmpp.hasOpenRoom(playerId));
    const triggerTop = triggerStep(rec, side, view, events, now, caches);
    const muted = mutedOf(playerId);
    let plan = planProactive(prev, { ...view, clonePending: clonePending.has(playerId),
      shipLost: shipLost.has(playerId), roomOpen, lastSpokeAt: lastSpokeAt.get(playerId),
      watchPending: pruneWatch(playerId, now), triggerTop, welcome: welcomeReady(playerId, now) },
    { quiet: p.quiet, lastProactiveAt: p.lastProactiveAt, lastByKind: kindsOf(playerId), alertsOff, muted }, now, S);
    if (wingLive) {
      wingStep(rec, side, now, caches, plan);
      if (muted.size > 0) plan = plan.filter((e) => !muted.has(e.kind));
      plan.sort((a, b) => b.priority - a.priority);
    }
    if (calloutLive) {
      const planned = planCallout(calloutState.get(playerId) || null, calloutPass(rec, side, now, caches), now, S);
      counters.calloutSuppressed += planned.suppressed;
      if (planned.line) {
        const kind = CALLOUT_KIND[planned.line.level];
        plan.push({ kind, line: CALLOUT, priority: PRIORITY[kind],
          callout: { ...planned, event: calloutEvent(planned.line, view, now) } });
        plan.sort((a, b) => b.priority - a.priority);
      }
      if (!planned.line || plan[0].line === CALLOUT) calloutState.set(playerId, planned.state);
      if (plan.length > 0 && plan[0].line === CALLOUT) events.push(plan[0].callout.event);
    }
    if (plan.length > 0 && plan[0].kind === "WING_HP") wingState.set(playerId, plan[0].wing.state);
    if (plan.length > 0 && plan[0].kind === "LOW_HP") events.push(lowHpEvent(view, now, S));
    if (plan.length > 0 && plan[0].kind === "WELCOME_BACK") {
      const due = welcomeDue.get(playerId);
      welcomeDue.delete(playerId);
      counters.welcomeLines += 1;
      if (due) events.push({ kind: "WELCOME_BACK", key: `welcome:${due.at}`, payload: { hours: due.hours } });
    }
    const trig = plan.length > 0 && plan[0].trigger ? plan[0] : null;
    let trigKey = null;
    if (trig) {
      const row = triggerEvent(trig.trigger);
      trigKey = row.key;
      if (row.kind === "DOCK_DAMAGED") {
        for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].kind === "DOCK") events.splice(i, 1);
      }
      if (!RAM_TRIGGER_KINDS.includes(row.kind)) events.push(row);
    }
    let inserted = null;
    if (events.length > 0) {
      const v = tx("shipAi.events.note", (db) => {
        const keys = [];
        for (const e of events) {
          const r = d.eventsRepo.noteEventInTx(db, { playerId, kind: e.kind, key: e.key, payload: e.payload,
            nowMs: now });
          if (!r.ok) return r;
          keys.push(r.inserted === true);
        }
        return { ok: true, inserted: keys };
      });
      if (v) {
        counters.events += events.length;
        inserted = v.inserted;
      }
    }
    if (trig) {
      const st = triggerState.get(playerId);
      if (st) st.pending.delete(trigKey);
      const kindD = trig.kind === "WORLD_NEWS" || trig.kind === "BATTLE_HERE" || trig.kind === "EVENT_HERE";
      if (!kindD) markActivitySpoken(st, trig.kind, now);
      const at = events.findIndex((e) => e.key === trigKey);
      const fresh = Array.isArray(inserted) && inserted[at] === true;
      if (trig.kind === "SEC_STATUS_DROP" && !fresh) {
        if (Array.isArray(inserted)) counters.triggerDuplicate += 1;
        return;
      }
      if (trig.kind === "SITE_CLEARED" && !fresh) {
        if (Array.isArray(inserted)) {
          counters.triggerDuplicate += 1;
          counters.siteDuplicate += 1;
        }
        return;
      }
      if (TRIGGER_KINDS_B.includes(trig.kind)) counters.activityLines += 1;
      if (trig.kind === "ABYSSAL") counters.abyssalLines += 1;
      if (kindD) {
        if (trig.kind === "WORLD_NEWS" && Array.isArray(inserted)) rememberTold(playerId, trig.trigger.key, now);
        if (!fresh) {
          if (Array.isArray(inserted)) counters.triggerDuplicate += 1;
          return;
        }
        markActivitySpoken(st, trig.kind, now);
        if (trig.kind === "WORLD_NEWS") {
          counters.worldLines += 1;
          if (st && st.lastWorldBySystem instanceof Map && isId(trig.trigger.systemId)) {
            st.lastWorldBySystem.set(trig.trigger.systemId, now);
          }
        } else {
          counters.hereLines += 1;
        }
      }
    }
    if (plan.length > 0 && !(plan[0].watch === true && inflight)) speak(playerId, plan[0], events, now);
  }

  function runPass() {
    if (stopped) return;
    if (!governorAdmits()) {
      counters.skippedGovernor += 1;
      return;
    }
    counters.passes += 1;
    writeLosses();
    const res = typeof d.adapter.readPresence === "function" ? d.adapter.readPresence() : null;
    const online = res && res.ok && Array.isArray(res.characters) ? res.characters : [];
    const now = d.nowMs();
    const seen = new Set();
    const caches = { grid: new Map(), inbound: new Map(), wing: new Map(), activity: drainActivity(),
      world: new Map() };
    if (worldQueue.length > 0) {
      const players = new Map();
      for (const rec of online) {
        if (!rec || !isId(rec.characterId) || !isId(rec.systemId) || players.has(rec.characterId)) continue;
        if (!d.isWatched(rec.characterId) || !d.isAllowed(rec.characterId) || prefsOf(rec.characterId).quiet) continue;
        players.set(rec.characterId, rec.systemId);
      }
      try {
        caches.world = drainWorld(players, now);
      } catch (err) {
        worldQueue.length = 0;
        log(`shipAi proactive: world news failed - ${codeOf(err && (err.code || err.name))}`);
      }
    }
    const present = new Set();
    const seenBatch = [];
    for (const rec of online) {
      if (!rec || !isId(rec.characterId) || !isId(rec.systemId) || seen.has(rec.characterId)
        || present.has(rec.characterId)) continue;
      const playerId = rec.characterId;
      if (!d.isWatched(playerId) || !d.isAllowed(playerId)) continue;
      const quiet = prefsOf(playerId).quiet === true;
      if (welcomeLive) {
        present.add(playerId);
        noteSeen(playerId, now, quiet, seenBatch);
      }
      if (quiet) continue;
      seen.add(playerId);
      try {
        observe(rec, now, caches);
      } catch (err) {
        log(`shipAi proactive: observe failed - ${codeOf(err && (err.code || err.name))}`);
      }
    }
    counters.watched = seen.size;
    if (welcomeLive) {
      try {
        writeSeen(seenBatch, now);
      } catch (err) {
        counters.seenWriteFailed += 1;
        log(`shipAi proactive: seen failed - ${codeOf(err && (err.code || err.name))}`);
      }
      for (const id of [...seenState.keys()]) if (!present.has(id)) seenState.delete(id);
      for (const id of [...welcomeDue.keys()]) if (!present.has(id) || prefsOf(id).quiet) welcomeDue.delete(id);
    }
    for (const list of caches.activity.values()) counters.activityDropped += list.length;
    for (const id of observer.keys()) {
      if (!seen.has(id)) {
        observer.delete(id);
        lastSpokeAt.delete(id);
        lastByKind.delete(id);
      }
    }
    for (const id of [...calloutState.keys()]) if (!seen.has(id)) calloutState.delete(id);
    for (const id of [...calloutOffers.keys()]) if (!seen.has(id)) calloutOffers.delete(id);
    for (const id of [...calloutDiag.keys()]) if (!seen.has(id)) calloutDiag.delete(id);
    for (const id of [...watchPending.keys()]) if (!seen.has(id)) dropWatch(id);
    for (const id of [...wingState.keys()]) if (!seen.has(id)) wingState.delete(id);
    for (const id of [...wingLosses.keys()]) if (!seen.has(id)) wingLosses.delete(id);
    for (const id of [...triggerState.keys()]) if (!seen.has(id)) triggerState.delete(id);
    for (const id of [...mutedSets.keys()]) if (!seen.has(id)) mutedSets.delete(id);
    for (const id of [...hereState.keys()]) if (!seen.has(id)) hereState.delete(id);
    for (const [id, c] of [...hereCache]) if (now - c.at >= S.worldHereScanMs) hereCache.delete(id);
    for (const id of [...abyssalState.keys()]) if (!seen.has(id)) abyssalState.delete(id);
    if (wingLosses.size === 0 && wingSeenLoss.size >= maxQueue) wingSeenLoss.clear();
    wingStats(now);
  }

  function dropWatch(playerId) {
    const pend = watchPending.get(playerId);
    if (!pend) return;
    counters.watchDropped += pend.size;
    watchPending.delete(playerId);
  }

  function offerWatchEvents(playerId, events) {
    if (stopped || !enabled || !isId(playerId) || prefsOf(playerId).quiet || !Array.isArray(events)) {
      return { queued: 0 };
    }
    const pend = watchPending.get(playerId) || new Map();
    let queued = 0;
    for (const e of events) {
      if (!e || !WATCH_KINDS.includes(e.kind) || typeof e.key !== "string" || e.key === "" || pend.has(e.key)
        || !Number.isSafeInteger(e.occurredAt) || mutedOf(playerId).has(e.kind)) continue;
      pend.set(e.key, { kind: e.kind, key: e.key, payload: e.payload && typeof e.payload === "object" ? e.payload : {},
        occurredAt: e.occurredAt, notedAt: Number.isSafeInteger(e.notedAt) ? e.notedAt : e.occurredAt,
        expiresAt: Number.isSafeInteger(e.expiresAt) ? e.expiresAt : null });
      queued += 1;
    }
    while (pend.size > S.watchMaxPending) {
      let oldest = null;
      for (const e of pend.values()) if (oldest === null || e.notedAt < oldest.notedAt) oldest = e;
      pend.delete(oldest.key);
      counters.watchDropped += 1;
    }
    if (pend.size > 0) watchPending.set(playerId, pend);
    counters.watchOffered += queued;
    return { queued };
  }

  const poller = createPoller({ runPass, intervalMs: S.proactivePollMs, now: () => d.nowMs(), setTimer: d.setTimer,
    onError: (err) => log(`shipAi proactive: pass failed - ${codeOf(err && (err.code || err.name))}`) });

  function start() {
    if (!enabled) return { ok: true, running: false };
    const pods = tx("shipAi.events.pods", (db) => d.eventsRepo.listPendingPods(db, Math.max(1, d.maxIdentities)));
    if (pods) {
      for (const id of pods.playerIds) clonePending.add(id);
      counters.clonesOwed = pods.playerIds.length;
    }
    if (typeof d.adapter.addLiveLossListener === "function") {
      let added;
      try {
        added = d.adapter.addLiveLossListener(noteLoss);
      } catch (err) {
        added = { ok: false, reason: codeOf(err && (err.code || err.message)) };
      }
      if (added && added.ok && typeof added.remove === "function") {
        removeListener = added.remove;
        lossSeam = "on";
      } else {
        lossSeam = codeOf(added && added.reason);
        log(`shipAi proactive: loss events off - ${lossSeam}`);
      }
    } else {
      lossSeam = "no_seam";
    }
    if (S.wingHpEnabled === true && typeof d.toolDeps.wingLoaded === "function") {
      const w = callDep("wingLoaded");
      wingLive = Boolean(w && w.ok === true && w.loaded === true);
      if (!wingLive) log(`shipAi proactive: wing off - ${w && w.ok === true ? "NOT_LOADED" : codeOf(w && w.reason)}`);
    }
    if (triggersLive && parseSecThresholds(S.secStatusThresholds) === null) triggerLogOnce("marks", "BAD_FORMAT");
    if (triggersLive) startActivity();
    if (triggersLive && S.worldNewsEnabled === true) startWorld();
    poller.start();
    return { ok: true, running: true };
  }

  function startWorld() {
    let n = null;
    try {
      n = typeof d.getNotices === "function" ? d.getNotices() : null;
    } catch (_err) {
      n = null;
    }
    let sub;
    try {
      sub = n && typeof n.onWarEvents === "function" ? n.onWarEvents(onWorldViews) : { ok: false,
        reason: "NOTICES_UNAVAILABLE" };
    } catch (err) {
      sub = { ok: false, reason: codeOf(err && (err.code || err.name)) };
    }
    if (sub && sub.ok === true && typeof sub.unsubscribe === "function") {
      worldUnsubscribe = sub.unsubscribe;
      worldSeam = "on";
      return;
    }
    const reason = sub && sub.reason;
    worldSeam = reason === "NOTICES_DISABLED" || reason === "NOTICES_UNAVAILABLE" ? "WORLD_NEWS_NEEDS_NOTICES"
      : codeOf(reason);
    log(`shipAi proactive: world news off - ${worldSeam}`);
  }

  function startActivity() {
    const act = d.seam && d.seam.activity && typeof d.seam.activity.installMiningHook === "function"
      ? d.seam.activity : null;
    const watched = (id) => !stopped && d.isWatched(id) === true && !prefsOf(id).quiet;
    const result = (name, run) => {
      if (!act) {
        activityStatus[name] = "no_seam";
        return;
      }
      let r;
      try {
        r = run();
      } catch (err) {
        r = { ok: false, reason: codeOf(err && (err.code || err.name)) };
      }
      if (r && r.ok === true) {
        activityStatus[name] = name === "kills" && r.wrapMounted !== true ? "no_wrap" : "on";
        return;
      }
      activityStatus[name] = codeOf(r && r.reason);
      triggerLogOnce(`${name} refused`, activityStatus[name]);
    };
    if (S.miningLinesEnabled === true) result("mining", () => act.installMiningHook(noteMiningStop, watched));
    if (S.siteClearedEnabled === true) {
      result("site", () => act.installSiteHook(noteSiteCleared, watched, S.siteClearedScanMax));
    }
    if (S.killLinesEnabled === true) result("kills", () => act.setKillListener({ onNpcKill: noteKill }));
  }

  function setQuiet(playerId, quiet) {
    prefs.set(playerId, { ...prefsOf(playerId), quiet: quiet === true });
    if (quiet === true) {
      observer.delete(playerId);
      calloutState.delete(playerId);
      calloutOffers.delete(playerId);
      wingState.delete(playerId);
      wingLosses.delete(playerId);
      triggerState.delete(playerId);
      shipLost.delete(playerId);
      dropWatch(playerId);
    }
  }

  function onPlayerSpoke(playerId) {
    if (isId(playerId)) lastSpokeAt.set(playerId, d.nowMs());
  }

  function noteIdentity(playerId) {
    if (!prefs.has(playerId)) {
      prefs.set(playerId, { quiet: false, lastProactiveAt: null, calloutMode: "on", dscanMode: "on", mutedKinds: [] });
    }
  }

  function setMutedKinds(playerId, kinds) {
    const own = Array.isArray(kinds) ? kinds.filter((k) => MUTE_KINDS.includes(k)) : [];
    prefs.set(playerId, { ...prefsOf(playerId), mutedKinds: own });
    mutedSets.delete(playerId);
    counters.muteCommands += 1;
    const muted = mutedOf(playerId);
    const st = triggerState.get(playerId);
    if (st) for (const [key, e] of [...st.pending]) if (muted.has(e.kind)) st.pending.delete(key);
    const pend = watchPending.get(playerId);
    if (pend) {
      for (const [key, e] of [...pend]) {
        if (muted.has(e.kind)) {
          pend.delete(key);
          counters.watchDropped += 1;
        }
      }
      if (pend.size === 0) watchPending.delete(playerId);
    }
    if (muted.has("WING_LOSS")) wingLosses.delete(playerId);
    if (muted.has("WELCOME_BACK")) welcomeDue.delete(playerId);
  }

  function mutedKindsOf(playerId) {
    const own = prefsOf(playerId).mutedKinds;
    return { own: Array.isArray(own) ? [...own].sort() : [], global: [...globalMuted].sort() };
  }

  function setAlertModes(playerId, modes) {
    const m = modes || {};
    const next = { ...prefsOf(playerId) };
    if (m.calloutMode === "on" || m.calloutMode === "off") next.calloutMode = m.calloutMode;
    if (m.dscanMode === "on" || m.dscanMode === "off") next.dscanMode = m.dscanMode;
    prefs.set(playerId, next);
    counters.alertCommands += 1;
    if (next.calloutMode === "off") {
      calloutState.delete(playerId);
      calloutOffers.delete(playerId);
    }
  }

  function alertModesOf(playerId) {
    const p = prefsOf(playerId);
    return { calloutMode: p.calloutMode === "off" ? "off" : "on", dscanMode: p.dscanMode === "off" ? "off" : "on" };
  }

  function isDscanAllowed(playerId) {
    if (stopped || !calloutOn || !isId(playerId)) return false;
    const p = prefsOf(playerId);
    return p.quiet !== true && p.calloutMode !== "off" && p.dscanMode !== "off";
  }

  function forget(playerId) {
    clonePending.delete(playerId);
    shipLost.delete(playerId);
    offered.delete(playerId);
    dropWatch(playerId);
    calloutState.delete(playerId);
    calloutOffers.delete(playerId);
    calloutDiag.delete(playerId);
    wingState.delete(playerId);
    wingLosses.delete(playerId);
    triggerState.delete(playerId);
    worldTold.delete(playerId);
  }

  function offerCallout(playerId, reading) {
    if (stopped || !calloutOn || !isId(playerId) || prefsOf(playerId).quiet || alertsOffOf(playerId) || !reading
      || !Object.prototype.hasOwnProperty.call(RANK, reading.level) || OWN_LEVELS.includes(reading.level)
      || !Array.isArray(reading.groups)) {
      return { queued: false };
    }
    const offers = calloutOffers.get(playerId) || new Map();
    offers.set(reading.level, { level: reading.level, groups: reading.groups.slice(),
      nearest: Number.isFinite(reading.nearest) ? reading.nearest : null,
      ...(isId(reading.systemId) ? { systemId: reading.systemId } : {}) });
    calloutOffers.set(playerId, offers);
    return { queued: true };
  }

  function calloutGroupsOf(playerId, systemId) {
    const out = new Map();
    const st = calloutState.get(playerId);
    if (!st || !isId(systemId) || st.systemId !== systemId || !(st.groups instanceof Map)) return out;
    for (const [key, g] of st.groups) out.set(key, { count: g.count, rank: g.rank });
    return out;
  }

  function lastEventFor(playerId) {
    if (!enabled) return null;
    const now = d.nowMs();
    const v = tx("shipAi.events.fresh", (db) => d.eventsRepo.latestFresh(db, playerId, now - S.silenceMs));
    if (!v || !v.row) {
      offered.delete(playerId);
      return null;
    }
    offered.set(playerId, v.row.key);
    return { ...eventData(v.row.kind, v.row), minutesAgo: Math.max(0, Math.floor((now - v.row.occurredAt)
      / MS_PER_MINUTE)) };
  }

  function onReplied(playerId) {
    const key = offered.get(playerId);
    if (!key) return;
    offered.delete(playerId);
    const pend = watchPending.get(playerId);
    if (pend && pend.delete(key) && pend.size === 0) watchPending.delete(playerId);
    const marked = tx("shipAi.events.mention", (db) => d.eventsRepo.markMentionedInTx(db, { playerId, key,
      atMs: d.nowMs() }));
    if (marked) counters.mentioned += marked.changed;
  }

  function recentEvents(playerId, n) {
    const res = d.store.transaction("shipAi.events.recent", (db) => d.eventsRepo.listRecent(db, playerId, n));
    const v = valueOf(res);
    if (!v) return { ok: false, reason: "EVENTS_UNAVAILABLE" };
    const now = d.nowMs();
    return { ok: true, events: v.rows.map((r) => ({ ...eventData(r.kind, r),
      minutesAgo: Math.max(0, Math.floor((now - r.occurredAt) / MS_PER_MINUTE)) })) };
  }

  function activityStatsOf() {
    const act = d.seam && d.seam.activity && typeof d.seam.activity.stats === "function" ? d.seam.activity : null;
    if (!act || !triggersLive) return null;
    try {
      return act.stats();
    } catch (_err) {
      return null;
    }
  }

  function getStatus() {
    let quiet = 0;
    let alertsOff = 0;
    let scanOff = 0;
    for (const p of prefs.values()) {
      if (p.quiet) quiet += 1;
      if (p.calloutMode === "off") alertsOff += 1;
      if (p.dscanMode === "off") scanOff += 1;
    }
    let watchQueued = 0;
    for (const pend of watchPending.values()) watchQueued += pend.size;
    return { enabled, state: stopped ? "stopped" : (enabled ? "running" : "off"), lossSeam, observed: observer.size(),
      quiet, alertsOff, scanOff, inflight, queuedLosses: lossQueue.length, clonesPending: clonePending.size, watchPending: watchQueued,
      wing: { live: wingLive, marks: wingMarks ? { ...wingMarks } : null, players: wingState.size },
      triggers: { enabled: triggersLive, crime: crimeStatus, players: triggerState.size, ...activityStatus,
        queuedFacts: activityQueue.length, hooks: activityStatsOf(),
        world: worldSeam, here: hereLive ? "on" : "off", queuedViews: worldQueue.length },
      welcome: { enabled: welcomeLive, seen: seenState.size, due: welcomeDue.size },
      counters: { ...counters }, byKind: { ...byKind } };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    generation += 1;
    poller.stop();
    if (removeListener) {
      try {
        removeListener();
      } catch (_err) {
      }
      removeListener = null;
    }
    if (triggersLive && d.seam && d.seam.activity && typeof d.seam.activity.uninstallAll === "function") {
      try {
        d.seam.activity.uninstallAll();
      } catch (_err) {
      }
    }
    activityQueue.length = 0;
    if (worldUnsubscribe) {
      try {
        worldUnsubscribe();
      } catch (_err) {
      }
      worldUnsubscribe = null;
    }
    worldQueue.length = 0;
    hereState.clear();
    hereCache.clear();
    abyssalState.clear();
    abyssalCache = null;
    worldTold.clear();
    killLabels.clear();
    observer.clear();
    lossQueue.length = 0;
    watchPending.clear();
    calloutState.clear();
    calloutOffers.clear();
    calloutDiag.clear();
    wingState.clear();
    wingLosses.clear();
    wingSeenLoss.clear();
    triggerState.clear();
    mutedSets.clear();
    seenState.clear();
    welcomeDue.clear();
  }

  function calloutDiagOf(playerId) {
    const c = {};
    for (const n of COUNTER_NAMES) if (n === "callouts" || n.startsWith("callout")) c[n] = counters[n];
    const s = calloutDiag.get(playerId);
    return { on: calloutOn && !stopped, counters: c, sector: s ? { agoMs: Math.max(0, d.nowMs() - s.atMs),
      npcs: s.npcs, inRange: s.inRange, hostile: s.hostile, noFaction: s.noFaction } : null };
  }

  function wingDiagOf(playerId) {
    const st = wingState.get(playerId);
    if (!st) return null;
    const c = {};
    for (const n of COUNTER_NAMES) if (n.startsWith("wing")) c[n] = counters[n];
    let left = 0;
    if (st.left instanceof Map) for (const list of st.left.values()) left += list.length;
    return { on: wingLive && !stopped, marks: wingMarks ? { ...wingMarks } : null, counters: c,
      copies: [...st.copies.values()].map((x) => ({ name: x.name, pct: (x.pct || []).slice(),
        armed: x.armed.slice() })),
      left, pending: st.pending.size,
      lastLineAgoMs: st.lastLineAt === null ? null : Math.max(0, d.nowMs() - st.lastLineAt),
      muted: mutedOf(playerId).has("WING_HP") };
  }

  return Object.freeze({ start, stop, setQuiet, onPlayerSpoke, noteIdentity, forget, lastEventFor, onReplied,
    recentEvents, getStatus, noteLoss, runPass, offerWatchEvents, offerCallout, setAlertModes, alertModesOf,
    isDscanAllowed, calloutDiagOf, wingDiagOf, calloutGroupsOf, isQuiet: (playerId) => prefsOf(playerId).quiet === true,
    setMutedKinds, mutedKindsOf, worldNewsCovers, worldNewsToldMail });
}

module.exports = { planProactive, createProactive, isLowHp, PRIORITY, LINE_KINDS, COUNTER_NAMES, WORK_CLASS,
  globalOkOf, hintOf, PRE_HTTP_REASONS };
