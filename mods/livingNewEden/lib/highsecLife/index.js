"use strict";

const { performance } = require("node:perf_hooks");
const { STATE, COUNTER_NAMES, CIVILIAN_OWNER_KIND, CHATTER_METRICS, CHATTER_COUNTER_NAMES, settingsOf,
  chatterSettingsOf, TRAFFIC_STATE, trafficSettingsOf, GANK_STATE, gankSettingsOf, RESIDENT_CHATTER_METRICS,
  RESIDENT_CHATTER_COUNTER_NAMES, freeChatterSettingsOf } = require("./schema");
const { createTraffic } = require("./traffic/service");
const { civilianProfilesByRole, pilotHullProfilesOf } = require("./traffic/plan");
const { createGank } = require("./gank/service");
const { buildHubDistance, computeCivilianTarget } = require("./density");
const { buildCivilianSpecs } = require("./civilians");
const { orderCivilians, releasedByChurn } = require("./churn");
const { chatterIntervalMs, pickLine, createLineLimiter } = require("./chatter");
const { toWarRumour, toBattleRumour, toGankRumour, toFreeCorpRumour, toSituationRumour, createRumourRing,
  eligibleRumours } = require("./rumours");
const { deterministicUnit } = require("../util/rng");
const { createPoller } = require("../presence/poller");

const MAX_DETAIL = 160;
const HOME_BAND = "highsec";
const MS_DECIMALS = 10;
const CHATTER_STATE = Object.freeze({ OFF: "off", RUNNING: "running", STOPPED: "stopped" });
const WORK_CLASS = "MAINTENANCE";
const TOLD_TRIM_FACTOR = 2;
const HOUR_MS = 3600000;
const FC_RUMOUR_KEY_PREFIX = "fc:";

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function createUnavailableHighsecLife(reason) {
  const why = String(reason || "HIGHSEC_LIFE_UNAVAILABLE");
  return Object.freeze({
    whenReady: () => Promise.resolve(),
    describeSystem: () => null,
    getSettings: () => null,
    civilianTargets: () => ({ ok: false, reason: why }),
    civilianOrder: () => [],
    civilianChurn: () => new Set(),
    noteCivilians: () => {},
    listCivilianRoster: () => ({ ok: false, reason: why }),
    noteResidents: () => {},
    trafficShipsIn: () => 0,
    onSituationRumour: () => false,
    getStatus: () => Object.freeze({ state: "unavailable", reason: why }),
    stop: () => {},
  });
}

function startHighsecLife(deps) {
  const config = deps && deps.config;
  const H = config && config.highsecLife;
  if (!H || H.enabled !== true || !H.civilians || H.civilians.enabled !== true) {
    return { ok: false, reason: "disabled_by_config" };
  }
  const lp = config.localPilots;
  const vcModule = config.modules && config.modules.virtualCorps;
  if (!lp || lp.enabled !== true || !vcModule || vcModule.enabled !== true) {
    return { ok: false, reason: "disabled_by_dependency",
      detail: !lp || lp.enabled !== true ? "localPilots.enabled" : "modules.virtualCorps" };
  }
  for (const k of ["getGraph", "getVirtualCorps", "listStations", "bloodlinesOf"]) {
    if (typeof deps[k] !== "function") return { ok: false, reason: "MISSING_DEPS", detail: k };
  }
  const settingsRes = settingsOf(config);
  if (!settingsRes.ok) return settingsRes;
  const S = settingsRes.settings;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const worldSeed = Number.isSafeInteger(deps.worldSeed) ? deps.worldSeed : 0;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`highsecLife: ${line}`);
    } catch (_err) {
    }
  }

  let state = STATE.STARTING;
  let stopped = false;
  let lastError = null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  const systems = new Map();

  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const telemetry = deps.telemetry || null;
  const chatterWanted = Boolean(H.chatter && H.chatter.enabled === true);
  const chatterRes = chatterWanted ? chatterSettingsOf(config) : null;
  const C = chatterRes && chatterRes.ok ? chatterRes.settings : null;
  let chatterState = CHATTER_STATE.OFF;
  let chatterError = chatterRes && !chatterRes.ok ? `${chatterRes.reason}:${chatterRes.detail}` : null;
  let rumourSource = "off:not_started";
  const chat = Object.fromEntries(CHATTER_COUNTER_NAMES.map((name) => [name, 0]));
  let graphRef = null;
  let civSnapshot = new Map();
  let civSnapshotAt = null;
  const perSystem = new Map();
  const warRing = createRumourRing({ size: C ? C.rumourRingSize : 1 });
  const battleRing = createRumourRing({ size: C ? C.rumourRingSize : 1 });
  const gankRing = createRumourRing({ size: C ? C.rumourRingSize : 1 });
  const sitRing = createRumourRing({ size: C ? C.rumourRingSize : 1 });
  const limiter = createLineLimiter(C ? C.maxLinesPerMinute : 0);
  let chatterPoller = null;
  let warUnsubscribe = null;

  const FC0 = config.freeCorps;
  const resWanted = Boolean(FC0 && FC0.enabled === true && FC0.chatter && FC0.chatter.enabled === true);
  const resSettingsRes = resWanted ? freeChatterSettingsOf(config) : null;
  const R0 = resSettingsRes && resSettingsRes.ok ? resSettingsRes.settings : null;
  let resState = CHATTER_STATE.OFF;
  let resError = resSettingsRes && !resSettingsRes.ok ? `${resSettingsRes.reason}:${resSettingsRes.detail}` : null;
  const resChat = Object.fromEntries(RESIDENT_CHATTER_COUNTER_NAMES.map((name) => [name, 0]));
  let resSnapshot = new Map();
  let resSnapshotAt = null;
  const resPerSystem = new Map();
  const fcRing = createRumourRing({ size: C ? C.rumourRingSize : 1 });
  let newsCursor = { afterAt: 0, afterId: null };
  let newsNextAt = 0;
  let fcChat = null;

  const trafficWanted = Boolean(H.traffic && H.traffic.enabled === true);
  const trafficRes = trafficWanted ? trafficSettingsOf(config) : null;
  const TR = trafficRes && trafficRes.ok ? trafficRes.settings : null;
  let trafficState = TRAFFIC_STATE.OFF;
  let trafficError = trafficRes && !trafficRes.ok ? `${trafficRes.reason}:${trafficRes.detail}` : null;
  let traffic = null;
  let trafficPoller = null;

  const gankWanted = Boolean(H.gank && H.gank.enabled === true);
  const gankRes = gankWanted ? gankSettingsOf(config) : null;
  const GK = gankRes && gankRes.ok ? gankRes.settings : null;
  let gankState = GANK_STATE.OFF;
  let gankError = gankRes && !gankRes.ok ? `${gankRes.reason}:${gankRes.detail}` : null;
  let gank = null;
  let gankPoller = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function soft(getter) {
    try {
      return typeof getter === "function" ? getter() || null : null;
    } catch (_err) {
      return null;
    }
  }

  function onWarViews(views) {
    if (chatterState !== CHATTER_STATE.RUNNING) return;
    for (const view of Array.isArray(views) ? views : []) {
      const r = toWarRumour(view);
      if (!r) chat.rumoursRejected += 1;
      else if (warRing.add(r)) chat.warRumoursAdded += 1;
    }
  }

  function placeOfSystem(systemId) {
    const graph = graphRef;
    const sys = graph && typeof graph.getSystem === "function" ? graph.getSystem(systemId) : null;
    if (!sys || typeof sys.name !== "string" || sys.name === "") return null;
    const regionName = sys.regionId != null && typeof graph.getRegionName === "function"
      ? graph.getRegionName(sys.regionId) : null;
    return { name: sys.name, regionName: regionName || null };
  }

  function readBattles() {
    const battle = soft(deps.getBattle);
    let st = null;
    try {
      st = battle && typeof battle.getStatus === "function" ? battle.getStatus() : null;
    } catch (_err) {
      st = null;
    }
    const list = st && Array.isArray(st.recentSettled) ? st.recentSettled : [];
    for (const entry of list) {
      const r = toBattleRumour(entry, placeOfSystem, C.rumourMinBattleLosses);
      if (r && battleRing.add(r)) chat.battleRumoursAdded += 1;
    }
  }

  function governorAdmits() {
    const g = soft(deps.getGovernor);
    try {
      return !g || typeof g.admits !== "function" || g.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function slotOf(now) {
    return Math.floor(now / C.minIntervalFloorMs);
  }

  function syncSystems(now) {
    for (const systemId of [...perSystem.keys()]) {
      const ids = civSnapshot.get(systemId);
      if (!ids || ids.length < C.minCivilians) perSystem.delete(systemId);
    }
    const slot = slotOf(now);
    for (const [systemId, ids] of civSnapshot) {
      if (ids.length < C.minCivilians || perSystem.has(systemId)) continue;
      const gap = chatterIntervalMs(ids.length, systemId, slot, worldSeed, C);
      const u = deterministicUnit(worldSeed >>> 0, "hs-chat-first", systemId, slot);
      perSystem.set(systemId, { nextAt: now + Math.round(gap * u), lastSpeaker: null, recentLineIds: [],
        toldRumours: new Set(), near: null });
    }
  }

  function trimTold(entry, rumours) {
    if (entry.toldRumours.size <= TOLD_TRIM_FACTOR * C.rumourRingSize) return;
    const keys = new Set(rumours.map((r) => r.key));
    for (const key of [...entry.toldRumours]) if (!keys.has(key)) entry.toldRumours.delete(key);
  }

  function noteRefusal(reason) {
    if (reason === "NO_SOCKET") chat.sendNoSocket += 1;
    else if (reason === "NOT_OCCUPANT") chat.sendNotOccupant += 1;
    else chat.sendOther += 1;
    metric("count", CHATTER_METRICS.sendFailed, 1);
  }

  function aiOverlayNow() {
    const svc = soft(deps.getChatterAi);
    try {
      const r = svc && typeof svc.overlay === "function" ? svc.overlay() : null;
      return r && r.ok === true ? { permille: r.permille, linesOf: r.linesOf } : null;
    } catch (_err) {
      return null;
    }
  }

  function speak(systemId, entry, ids, now, rumours, ai) {
    if (entry.near === null) entry.near = buildHubDistance(graphRef, [systemId], C.rumourMaxJumps);
    const sys = systems.get(systemId) || null;
    const place = placeOfSystem(systemId);
    const isHub = Boolean(sys && sys.isHub);
    trimTold(entry, rumours);
    const heard = eligibleRumours(rumours, { systemId, isHub }, entry.near, entry.toldRumours, now, C);
    const slot = slotOf(now);
    const pick = pickLine({ systemId, slot, seed: worldSeed, speakers: ids, lastSpeaker: entry.lastSpeaker,
      place: { systemName: place ? place.name : null, regionName: place ? place.regionName : null, isHub,
        hubJumps: sys ? sys.hubJumps : null },
      rumours: heard, recentLineIds: entry.recentLineIds, C, ai });
    entry.nextAt = now + chatterIntervalMs(ids.length, systemId, slot, worldSeed, C);
    if (!pick.ok) {
      chat.sendOther += 1;
      return;
    }
    let sent;
    try {
      sent = deps.sendOccupantMessage({ systemId, characterId: pick.characterId, text: pick.text });
    } catch (_err) {
      sent = { ok: false, reason: "SEND_THREW" };
    }
    if (!sent || sent.ok !== true) {
      noteRefusal(sent && sent.reason);
      return;
    }
    chat.lines += 1;
    metric("count", CHATTER_METRICS.lines, 1);
    if (pick.source === "ai") {
      chat.aiLines += 1;
      metric("count", CHATTER_METRICS.aiLines, 1);
    }
    if (pick.rumourKey !== null) {
      chat.rumours += 1;
      entry.toldRumours.add(pick.rumourKey);
      metric("count", CHATTER_METRICS.rumours, 1);
      if (pick.rumourKey.startsWith(FC_RUMOUR_KEY_PREFIX)) metric("count", RESIDENT_CHATTER_METRICS.fcRumours, 1);
    }
    entry.recentLineIds.push(pick.lineId);
    while (entry.recentLineIds.length > C.recentLinesPerSystem) entry.recentLineIds.shift();
    entry.lastSpeaker = pick.characterId;
  }

  function syncResidents(now) {
    for (const systemId of [...resPerSystem.keys()]) {
      const ids = resSnapshot.get(systemId);
      if (!ids || ids.length < R0.minResidents) resPerSystem.delete(systemId);
    }
    const slot = slotOf(now);
    for (const [systemId, ids] of resSnapshot) {
      if (ids.length < R0.minResidents || resPerSystem.has(systemId)) continue;
      const gap = fcChat.residentGapMs(ids.length, systemId, slot, worldSeed, C);
      const u = deterministicUnit(worldSeed >>> 0, "fc-chat-first", systemId, slot);
      resPerSystem.set(systemId, { nextAt: now + Math.round(gap * u), lastSpeaker: null, recentLineIds: [],
        sentAt: [] });
    }
  }

  function noteResidentRefusal(reason) {
    if (reason === "NO_SOCKET") resChat.sendNoSocket += 1;
    else if (reason === "NOT_OCCUPANT") resChat.sendNotOccupant += 1;
    else resChat.sendOther += 1;
    metric("count", CHATTER_METRICS.sendFailed, 1);
  }

  function speakResident(systemId, entry, ids, now, ai) {
    const slot = slotOf(now);
    entry.nextAt = now + fcChat.residentGapMs(ids.length, systemId, slot, worldSeed, C);
    let got = null;
    try {
      const fc = soft(deps.getFreeCorps);
      got = fc && typeof fc.chatterSpeakers === "function" ? fc.chatterSpeakers(systemId, now) : null;
    } catch (_err) {
      got = null;
    }
    if (!got || got.ok !== true || !Array.isArray(got.speakers)) {
      resChat.speakersFailed += 1;
      entry.sentAt.push(now);
      return;
    }
    const shown = new Set(ids);
    const speakers = got.speakers.filter((s) => s && shown.has(s.characterId));
    if (speakers.length === 0) {
      resChat.noSpeaker += 1;
      return;
    }
    const place = placeOfSystem(systemId);
    const pick = fcChat.pickResidentLine({ systemId, slot, seed: worldSeed, speakers, lastSpeaker: entry.lastSpeaker,
      recentLineIds: entry.recentLineIds, listenerName: place ? place.name : null,
      nameOf: (id) => {
        const p = placeOfSystem(id);
        return p ? p.name : null;
      },
      minRichIsk: R0.rumourMinYieldIsk, maxLineChars: C.maxLineChars, ai });
    if (!pick || pick.ok !== true) {
      resChat.noLine += 1;
      return;
    }
    let sent;
    try {
      sent = deps.sendOccupantMessage({ systemId, characterId: pick.characterId, text: pick.text });
    } catch (_err) {
      sent = { ok: false, reason: "SEND_THREW" };
    }
    if (!sent || sent.ok !== true) {
      noteResidentRefusal(sent && sent.reason);
      return;
    }
    resChat.lines += 1;
    metric("count", RESIDENT_CHATTER_METRICS.lines, 1);
    if (pick.source === "ai") {
      resChat.aiLines += 1;
      metric("count", CHATTER_METRICS.aiLines, 1);
    }
    entry.sentAt.push(now);
    entry.recentLineIds.push(pick.lineId);
    while (entry.recentLineIds.length > C.recentLinesPerSystem) entry.recentLineIds.shift();
    entry.lastSpeaker = pick.characterId;
  }

  function pollNews(now) {
    if (now < newsNextAt) return;
    let r = null;
    try {
      const fc = soft(deps.getFreeCorps);
      r = fc && typeof fc.ventureNews === "function" ? fc.ventureNews({ afterAt: newsCursor.afterAt,
        afterId: newsCursor.afterId, limit: R0.newsReadLimit, minYieldIsk: R0.rumourMinYieldIsk,
        minCrewLost: R0.rumourMinCrewLost }) : null;
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true || !Array.isArray(r.items)) {
      resChat.newsFailed += 1;
      newsNextAt = now + R0.newsPollMs;
      return;
    }
    resChat.newsReads += 1;
    for (const item of r.items) {
      const rumour = toFreeCorpRumour(item, placeOfSystem);
      if (!rumour) chat.rumoursRejected += 1;
      else if (fcRing.add(rumour)) resChat.fcRumoursAdded += 1;
    }
    const last = r.items.length > 0 ? r.items[r.items.length - 1] : null;
    if (r.full === true && last) {
      newsCursor = { afterAt: last.endedAt, afterId: last.ventureId };
      newsNextAt = now;
    } else if (r.full === true) {
      newsNextAt = now + R0.newsPollMs;
    } else {
      newsCursor = { afterAt: now, afterId: null };
      newsNextAt = now + R0.newsPollMs;
    }
  }

  function residentLane(now, limitedBefore, ai) {
    syncResidents(now);
    const due = [...resPerSystem].filter(([, e]) => e.nextAt <= now)
      .sort((a, b) => (a[1].nextAt - b[1].nextAt) || (a[0] - b[0]));
    let limited = limitedBefore;
    for (const [systemId, entry] of due) {
      const ids = resSnapshot.get(systemId);
      while (entry.sentAt.length > 0 && now - entry.sentAt[0] >= HOUR_MS) entry.sentAt.shift();
      if (entry.sentAt.length >= R0.maxLinesPerSystemPerHour) {
        resChat.hourLimited += 1;
        metric("count", RESIDENT_CHATTER_METRICS.hourLimited, 1);
        entry.nextAt = now + fcChat.residentGapMs(ids.length, systemId, slotOf(now), worldSeed, C);
        continue;
      }
      if (limited || !limiter.tryTake(now)) {
        limited = true;
        resChat.rateLimited += 1;
        continue;
      }
      speakResident(systemId, entry, ids, now, ai);
    }
  }

  function chatterTick() {
    if (chatterState !== CHATTER_STATE.RUNNING || stopped || state !== STATE.RUNNING) return;
    if (!governorAdmits()) {
      chat.deferred += 1;
      return;
    }
    const t0 = nowMs();
    try {
      const now = clock.now();
      const residentsOn = resState === CHATTER_STATE.RUNNING;
      const ai = aiOverlayNow();
      readBattles();
      warRing.prune(now, C.rumourMaxAgeMs);
      battleRing.prune(now, C.rumourMaxAgeMs);
      gankRing.prune(now, C.rumourMaxAgeMs);
      sitRing.prune(now, C.rumourMaxAgeMs);
      if (residentsOn) {
        fcRing.prune(now, C.rumourMaxAgeMs);
        pollNews(now);
      }
      syncSystems(now);
      const due = [...perSystem].filter(([, e]) => e.nextAt <= now)
        .sort((a, b) => (a[1].nextAt - b[1].nextAt) || (a[0] - b[0]));
      let limited = false;
      if (due.length > 0) {
        const rumours = [...warRing.list(), ...battleRing.list(), ...gankRing.list(), ...sitRing.list(),
          ...(residentsOn ? fcRing.list() : [])];
        for (const [systemId, entry] of due) {
          if (limited || !limiter.tryTake(now)) {
            limited = true;
            chat.rateLimited += 1;
            metric("count", CHATTER_METRICS.rateLimited, 1);
            continue;
          }
          speak(systemId, entry, civSnapshot.get(systemId), now, rumours, ai);
        }
      }
      if (residentsOn) residentLane(now, limited, ai);
    } catch (err) {
      chat.errors += 1;
      log(`chatter tick failed - ${messageOf(err)}`);
    }
    metric("observe", CHATTER_METRICS.passMs, Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
  }

  function startChatter() {
    if (!chatterWanted) return;
    if (!C) {
      log(`chatter off - ${chatterError}`);
      return;
    }
    if (typeof deps.sendOccupantMessage !== "function") {
      chatterError = "MISSING_DEPS:sendOccupantMessage";
      log(`chatter off - ${chatterError}`);
      return;
    }
    const notices = soft(deps.getNotices);
    try {
      const sub = notices && typeof notices.onWarEvents === "function" ? notices.onWarEvents(onWarViews) : null;
      if (sub && sub.ok === true && typeof sub.unsubscribe === "function") {
        warUnsubscribe = sub.unsubscribe;
        rumourSource = "notices";
      } else {
        rumourSource = `off:${(sub && sub.reason) || "NOTICES_UNAVAILABLE"}`;
      }
    } catch (err) {
      rumourSource = `off:${messageOf(err)}`;
    }
    chatterPoller = createPoller({ runPass: chatterTick, intervalMs: C.tickMs, now: () => clock.now(),
      setTimer: deps.setTimer, onError: (err) => {
        chat.errors += 1;
        log(`chatter timer failed - ${messageOf(err)}`);
      } });
    chatterState = CHATTER_STATE.RUNNING;
    const armed = chatterPoller.start();
    if (armed && armed.ok === false) {
      chatterError = `TIMER_FAILED:${armed.reason}`;
      stopChatter();
      chatterState = CHATTER_STATE.OFF;
      return;
    }
    log(`chatter running - rumours ${rumourSource}`);
    startResidents();
  }

  function startResidents() {
    if (!resWanted) return;
    if (!R0) {
      log(`resident lane off - ${resError}`);
      return;
    }
    const fcc = deps.freeCorpsChatter;
    if (typeof deps.getFreeCorps !== "function") {
      resError = "MISSING_DEPS:getFreeCorps";
    } else if (!fcc || typeof fcc.pickResidentLine !== "function" || typeof fcc.residentGapMs !== "function") {
      resError = "MISSING_DEPS:freeCorpsChatter";
    }
    if (resError) {
      log(`resident lane off - ${resError}`);
      return;
    }
    fcChat = fcc;
    newsCursor = { afterAt: Math.max(0, clock.now() - C.rumourMaxAgeMs), afterId: null };
    newsNextAt = 0;
    resState = CHATTER_STATE.RUNNING;
    log(`resident lane running (max ${R0.maxLinesPerSystemPerHour}/system/hour)`);
  }

  function stopResidents() {
    if (resState !== CHATTER_STATE.RUNNING) return;
    resState = CHATTER_STATE.STOPPED;
    resSnapshot = new Map();
    resSnapshotAt = null;
    resPerSystem.clear();
    fcRing.clear();
    newsCursor = { afterAt: 0, afterId: null };
    newsNextAt = 0;
  }

  function stopChatter() {
    if (chatterState !== CHATTER_STATE.RUNNING) return;
    chatterState = CHATTER_STATE.STOPPED;
    try {
      if (chatterPoller) chatterPoller.stop();
    } catch (_err) {
    }
    try {
      if (warUnsubscribe) warUnsubscribe();
    } catch (_err) {
    }
    warUnsubscribe = null;
    civSnapshot = new Map();
    civSnapshotAt = null;
    perSystem.clear();
    warRing.clear();
    battleRing.clear();
    gankRing.clear();
    sitRing.clear();
    stopResidents();
  }

  function noteCivilians(bySystem, atMs) {
    if (state !== STATE.RUNNING || stopped || !(bySystem instanceof Map)) return;
    const copy = new Map();
    for (const [systemId, ids] of bySystem) {
      if (!Number.isSafeInteger(systemId) || systemId <= 0 || !Array.isArray(ids)) continue;
      copy.set(systemId, ids.filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b));
    }
    civSnapshot = copy;
    civSnapshotAt = Number.isFinite(atMs) ? atMs : null;
  }

  function noteResidents(bySystem, atMs) {
    if (resState !== CHATTER_STATE.RUNNING || stopped || !(bySystem instanceof Map)) return;
    const copy = new Map();
    for (const [systemId, ids] of bySystem) {
      if (!Number.isSafeInteger(systemId) || systemId <= 0 || !Array.isArray(ids)) continue;
      copy.set(systemId, ids.filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b));
    }
    resSnapshot = copy;
    resSnapshotAt = Number.isFinite(atMs) ? atMs : null;
  }

  function residentsStatus() {
    const why = resError || (resState === CHATTER_STATE.OFF ? `CHATTER_${chatterState.toUpperCase()}` : null);
    return Object.freeze({ state: resState, systems: resPerSystem.size, snapshotSystems: resSnapshot.size,
      snapshotAt: resSnapshotAt, fcRumours: fcRing.size(), counters: Object.freeze({ ...resChat }),
      ...(why ? { lastError: why } : {}) });
  }

  function chatterStatus() {
    return Object.freeze({ state: chatterState, rumourSource, systems: perSystem.size, snapshotSystems: civSnapshot.size,
      snapshotAt: civSnapshotAt, warRumours: warRing.size(), battleRumours: battleRing.size(),
      counters: Object.freeze({ ...chat }), ...(resWanted ? { residents: residentsStatus() } : {}),
      ...(chatterError ? { lastError: chatterError } : {}) });
  }

  function populationLiveOf() {
    const P = config.population;
    if (!P || P.enabled !== true || !P.near || P.near.enabled !== true || !P.live || P.live.trafficEnabled !== true
      || typeof deps.getPopulation !== "function") return {};
    return { populationLive: Object.freeze({ settings: P.live, getPopulation: deps.getPopulation,
      leaseOf: (pilotId) => {
        const lp = typeof deps.getLocalPilots === "function" ? deps.getLocalPilots() : null;
        return lp && typeof lp.populationLeaseOf === "function" ? lp.populationLeaseOf(pilotId)
          : { ok: false, reason: "NOT_RUNNING" };
      },
      spawnBackoff: deps.populationSpawnBackoff || null, failureReasonOf: deps.spawnFailureReasonOf || null,
      ...pilotHullsOf(P), ...groupSpawnOf(P),
      ...(P.live.standingAggroEnabled === true && typeof deps.isLiveBattleShip === "function"
        ? { isLiveBattleShip: deps.isLiveBattleShip } : {}) }) };
  }

  function groupSpawnOf(P) {
    const G = P.groups;
    if (!G || G.enabled !== true || G.liveSpawnEnabled !== true || !Number.isFinite(G.liveSpacingMeters)) return {};
    return { groupSpawn: Object.freeze({ spacingMeters: G.liveSpacingMeters }) };
  }

  function pilotHullsOf(P) {
    const civ = deps.civilianHulls;
    if (!P.hulls || P.hulls.enabled !== true || !TR || TR.civilianHullsEnabled !== true || !civ
      || typeof civ.civilianDataOf !== "function" || typeof deps.readTypeLooks !== "function") return {};
    return { hullProfiles: pilotHullProfilesOf(civ.civilianDataOf({ pilotHulls: true })),
      readTypeLooks: deps.readTypeLooks };
  }

  function startTraffic() {
    if (!trafficWanted) return;
    const refuse = (why) => {
      trafficError = why;
      log(`traffic off - ${why}`);
    };
    if (!TR) {
      log(`traffic off - ${trafficError}`);
      return;
    }
    if (typeof deps.getTrafficScene !== "function") return refuse("MISSING_DEPS:getTrafficScene");
    let seam = null;
    try {
      const got = deps.getTrafficScene();
      seam = got && got.ok === true ? got.seam : null;
      if (!seam) return refuse(`SEAM_UNAVAILABLE:${(got && got.reason) || "NO_SEAM"}`);
    } catch (err) {
      return refuse(`SEAM_UNAVAILABLE:${messageOf(err)}`);
    }
    const speakersOf = (id) => {
      const lp = typeof deps.getLocalPilots === "function" ? deps.getLocalPilots() : null;
      return lp && typeof lp.speakersOf === "function" ? lp.speakersOf(id) : { ok: false, reason: "NOT_RUNNING" };
    };
    const made = createTraffic({ settings: TR, scene: seam, clock, rng: deps.rng, getPresence: deps.getPresence,
      describeSystem: (id) => systems.get(Number(id)) || null,
      wantedOf: (id, now) => {
        const sys = systems.get(Number(id));
        if (sys) return computeCivilianTarget(sys, now, worldSeed, S).wanted;
        const sp = speakersOf(Number(id));
        return sp && sp.ok === true ? sp.civilians.length + sp.residents.length : 0;
      },
      secClassOf: (id) => {
        const sys = graphRef && typeof graphRef.getSystem === "function" ? graphRef.getSystem(Number(id)) : null;
        return sys && typeof sys.secClass === "string" ? sys.secClass : null;
      },
      speakersOf, readCharacterNames: deps.readCharacterNames,
      profiles: deps.trafficProfiles,
      ...(TR.civilianHullsEnabled === true ? { profilesByRole: civilianProfilesByRole(deps.civilianHulls) } : {}),
      ...populationLiveOf(), getGovernor: deps.getGovernor, telemetry, logger, nowMs });
    if (!made.ok) return refuse(`${made.reason}:${made.detail}`);
    traffic = made.traffic;
    trafficPoller = createPoller({ runPass: () => traffic.tick(), intervalMs: TR.pollMs, now: () => clock.now(),
      setTimer: deps.setTimer, onError: (err) => log(`traffic timer failed - ${messageOf(err)}`),
      pacing: false });
    trafficState = TRAFFIC_STATE.RUNNING;
    const armed = trafficPoller.start();
    if (armed && armed.ok === false) {
      stopTraffic();
      trafficState = TRAFFIC_STATE.OFF;
      return refuse(`TIMER_FAILED:${armed.reason}`);
    }
    log(`traffic running (poll ${TR.pollMs}ms, max ${TR.maxShipsPerSystem}/system, ${TR.maxShipsGlobal} global)`);
    return undefined;
  }

  function stopTraffic() {
    if (trafficState !== TRAFFIC_STATE.RUNNING) return;
    trafficState = TRAFFIC_STATE.STOPPED;
    try {
      if (trafficPoller) trafficPoller.stop();
    } catch (_err) {
    }
    try {
      if (traffic) traffic.stop();
    } catch (_err) {
    }
  }

  function trafficStatus() {
    return Object.freeze({ state: trafficState, ...(traffic ? traffic.status() : {}),
      ...(trafficError ? { lastError: trafficError } : {}) });
  }

  function onGankRumour(event) {
    if (chatterState !== CHATTER_STATE.RUNNING) return false;
    const r = toGankRumour(event, placeOfSystem);
    if (!r) {
      chat.rumoursRejected += 1;
      return false;
    }
    return gankRing.add(r);
  }

  function onSituationRumour(event) {
    if (chatterState !== CHATTER_STATE.RUNNING) return false;
    const r = toSituationRumour(event, placeOfSystem);
    if (!r) {
      chat.rumoursRejected += 1;
      return false;
    }
    return sitRing.add(r);
  }

  function empireFactionOf(systemId) {
    if (typeof deps.resolveEmpireFaction !== "function" || !graphRef) return { ok: false, reason: "NO_RESOLVER" };
    return deps.resolveEmpireFaction(graphRef, systemId);
  }

  function startGank() {
    if (!gankWanted) return undefined;
    const refuse = (why) => {
      gankError = why;
      log(`gank off - ${why}`);
    };
    if (!GK) {
      log(`gank off - ${gankError}`);
      return undefined;
    }
    if (typeof deps.getWrecks !== "function") return refuse("MISSING_DEPS:getWrecks");
    const made = createGank({ settings: GK, worldSeed, hourCurvePermille: S.hourCurvePermille, clock,
      describeSystem: (id) => systems.get(Number(id)) || null, empireFactionOf, getWrecks: deps.getWrecks,
      getGovernor: deps.getGovernor, onRumour: onGankRumour, telemetry, logger, nowMs });
    if (!made.ok) return refuse(`${made.reason}:${made.detail}`);
    gank = made.gank;
    gankPoller = createPoller({ runPass: () => gank.runPass(clock.now()), intervalMs: GK.pollMs,
      now: () => clock.now(), setTimer: deps.setTimer,
      onError: (err) => log(`gank timer failed - ${messageOf(err)}`) });
    gankState = GANK_STATE.RUNNING;
    const armed = gankPoller.start();
    if (armed && armed.ok === false) {
      stopGank();
      gankState = GANK_STATE.OFF;
      return refuse(`TIMER_FAILED:${armed.reason}`);
    }
    log(`gank running (poll ${GK.pollMs}ms, bucket ${GK.bucketMs}ms, ${GK.systemIds.length} systems)`);
    return undefined;
  }

  function stopGank() {
    if (gankState !== GANK_STATE.RUNNING) return;
    gankState = GANK_STATE.STOPPED;
    try {
      if (gankPoller) gankPoller.stop();
    } catch (_err) {
    }
    try {
      if (gank) gank.stop();
    } catch (_err) {
    }
  }

  function gankStatus() {
    return Object.freeze({ state: gankState, ...(gank ? gank.getStatus() : {}),
      ...(gankError ? { lastError: gankError } : {}) });
  }

  function stationsOf(systemId) {
    try {
      const r = deps.listStations(systemId);
      if (r && r.ok === true && Array.isArray(r.stations)) return r.stations;
    } catch (_err) {
    }
    counters.stationsReadFailed += 1;
    return [];
  }

  function buildSystems(graph) {
    const hubDistance = buildHubDistance(graph, S.hubSystemIds, S.maxHubJumps);
    const hubs = new Set(S.hubSystemIds);
    const homeStations = [];
    for (const band of S.bands) {
      for (const systemId of graph.getSystemsBySecClass(band) || []) {
        const stations = stationsOf(systemId);
        const jumps = hubDistance.has(systemId) ? hubDistance.get(systemId) : null;
        systems.set(systemId, Object.freeze({ systemId, secClass: band, stationCount: stations.length,
          hubJumps: jumps, isHub: hubs.has(systemId), isPrimeHub: systemId === S.hubSystemIds[0] }));
        if (band !== HOME_BAND) continue;
        for (const st of stations) {
          homeStations.push({ stationId: st.stationId, corporationId: st.corporationId || null, systemId });
        }
      }
    }
    homeStations.sort((a, b) => a.stationId - b.stationId);
    return homeStations;
  }

  function ensureIdentities(graph, homeStations) {
    const vc = deps.getVirtualCorps();
    if (!vc || typeof vc.ensureOwnerIdentity !== "function" || typeof vc.getOwnerIdentity !== "function") {
      counters.identitiesFailed += S.civilianCorps;
      log("virtualCorps unavailable - no civilian identities");
      return;
    }
    const specs = buildCivilianSpecs({ slots: S.civilianCorps, members: S.civilianMembersPerCorp, worldSeed,
      stations: homeStations, getSystem: (id) => graph.getSystem(id), bloodlinesOf: deps.bloodlinesOf });
    for (const item of specs) {
      if (stopped) return;
      if (!item.ok) {
        counters.identitiesFailed += 1;
        log(`civilian slot ${item.slot} skipped - ${item.reason}`);
        continue;
      }
      const seen = vc.getOwnerIdentity(CIVILIAN_OWNER_KIND, item.slot);
      const refusedMembers = seen && seen.ok === true ? Number(seen.refusedMemberCount) || 0 : 0;
      if (seen && seen.ok === true && seen.state === "LINKED" && Array.isArray(seen.characterIds)
        && seen.characterIds.length + refusedMembers >= S.civilianMembersPerCorp) {
        counters.identitiesLinked += 1;
        counters.membersRefused += refusedMembers;
        continue;
      }
      if (seen && seen.ok === true && seen.state === "REFUSED") {
        counters.identitiesRefused += 1;
        continue;
      }
      const r = vc.ensureOwnerIdentity(item.spec);
      if (r && r.ok === true) {
        counters.identitiesEnsured += 1;
      } else {
        counters.identitiesFailed += 1;
        log(`civilian slot ${item.slot} refused - ${(r && r.reason) || "UNKNOWN"}`);
      }
    }
  }

  const ready = (async () => {
    try {
      const facade = deps.getGraph();
      const g = facade && typeof facade.whenReady === "function" ? await facade.whenReady() : null;
      if (stopped) return;
      if (!g || g.ok !== true || !g.graph) {
        counters.bootFailed += 1;
        lastError = "GRAPH_UNAVAILABLE";
        log("graph unavailable - no density inputs, no civilian identities");
        return;
      }
      graphRef = g.graph;
      const homeStations = buildSystems(g.graph);
      if (counters.stationsReadFailed > 0) {
        log(`stations read failed in ${counters.stationsReadFailed} systems - density falls back to BASE`);
      }
      ensureIdentities(g.graph, homeStations);
      if (stopped) return;
      state = STATE.RUNNING;
      log(`running - ${systems.size} systems, civilians ensured ${counters.identitiesEnsured}, linked `
        + `${counters.identitiesLinked}, refused ${counters.identitiesRefused}, failed ${counters.identitiesFailed}`);
      startChatter();
      startTraffic();
      startGank();
    } catch (err) {
      counters.bootFailed += 1;
      lastError = messageOf(err);
      log(`boot failed - ${lastError}`);
    }
  })();

  function civilianTargets(systemIds, atMs) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "NOT_RUNNING" };
    const time = Number.isFinite(atMs) ? atMs : 0;
    const targets = new Map();
    for (const id of Array.isArray(systemIds) ? systemIds : []) {
      const sys = systems.get(Number(id));
      if (!sys) continue;
      const wanted = computeCivilianTarget(sys, time, worldSeed, S).wanted;
      if (wanted > 0) targets.set(sys.systemId, wanted);
    }
    return { ok: true, bucket: Math.floor(time / S.bucketMs), targets };
  }

  function civilianOrder(characterIds, bucket, released) {
    if (state !== STATE.RUNNING) return [];
    const order = orderCivilians(characterIds, bucket, worldSeed);
    if (!(released instanceof Set) || released.size === 0) return order;
    return [...order.filter((id) => !released.has(id)), ...order.filter((id) => released.has(id))];
  }

  function civilianChurn(previous, bucket) {
    if (state !== STATE.RUNNING) return new Set();
    return releasedByChurn(previous, bucket, worldSeed, S.churnPermille);
  }

  let civNames = new Map();
  let civNamesVersion = null;

  function civilianNames() {
    try {
      const vc = deps.getVirtualCorps();
      if (!vc || typeof vc.getMapVersion !== "function" || typeof vc.getOwnerIdentity !== "function") {
        return new Map();
      }
      const version = vc.getMapVersion();
      if (civNamesVersion !== null && version === civNamesVersion) return civNames;
      const names = new Map();
      for (let slot = 1; slot <= S.civilianCorps; slot += 1) {
        const id = vc.getOwnerIdentity(CIVILIAN_OWNER_KIND, slot);
        if (!id || id.ok !== true || id.state !== "LINKED" || !Array.isArray(id.characterIds)
          || !Array.isArray(id.memberNames)) continue;
        id.characterIds.forEach((characterId, i) => {
          const name = id.memberNames[i];
          if (Number.isSafeInteger(characterId) && typeof name === "string" && name) names.set(characterId, name);
        });
      }
      civNames = names;
      civNamesVersion = version;
      return civNames;
    } catch (_err) {
      return new Map();
    }
  }

  function listCivilianRoster(opts) {
    if (state !== STATE.RUNNING || stopped) return { ok: false, reason: "NOT_RUNNING" };
    const raw = opts && opts.maxNames;
    const maxNames = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
    const names = maxNames > 0 && civSnapshot.size > 0 ? civilianNames() : new Map();
    const systemsOut = [];
    for (const [systemId, ids] of civSnapshot) {
      if (ids.length === 0) continue;
      const known = [];
      for (const id of ids) {
        if (known.length >= maxNames) break;
        const name = names.get(id);
        if (name) known.push(name);
      }
      systemsOut.push(Object.freeze({ systemId, count: ids.length, names: Object.freeze(known) }));
    }
    systemsOut.sort((a, b) => b.count - a.count || a.systemId - b.systemId);
    return { ok: true, atMs: civSnapshotAt, systems: Object.freeze(systemsOut) };
  }

  const highsecLife = Object.freeze({
    whenReady: () => ready,
    describeSystem: (systemId) => systems.get(Number(systemId)) || null,
    getSettings: () => S,
    civilianTargets,
    civilianOrder,
    civilianChurn,
    noteCivilians,
    noteResidents,
    getStatus: () => Object.freeze({ state, systems: systems.size, counters: Object.freeze({ ...counters }),
      chatter: chatterStatus(), traffic: trafficStatus(), gank: gankStatus(), ...(lastError ? { lastError } : {}) }),
    listCivilianRoster,
    trafficShipsIn: (systemId) => (traffic && trafficState === TRAFFIC_STATE.RUNNING ? traffic.shipsIn(systemId) : 0),
    onSituationRumour: (event) => {
      try {
        return onSituationRumour(event);
      } catch (_err) {
        return false;
      }
    },
    stop: () => {
      stopped = true;
      state = STATE.STOPPED;
      stopChatter();
      stopTraffic();
      stopGank();
      civSnapshot = new Map();
      civSnapshotAt = null;
    },
  });
  return { ok: true, highsecLife };
}

module.exports = { startHighsecLife, createUnavailableHighsecLife };
