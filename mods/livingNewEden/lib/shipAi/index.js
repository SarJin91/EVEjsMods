"use strict";

const S = require("./schema");
const { ensureIdentity, buildAiRecord } = require("./identity");
const { parseAiCommand, MEMORY_KINDS, QUIET_KINDS, MAIL_KINDS, PERSONA_KINDS, ALERT_KINDS,
  MUTE_KINDS_CMD, AUTO_KINDS } = require("./commands");
const { createShipAiAutostart } = require("./autostart");
const { MUTE_TEXT } = require("./data/triggers");
const { createShipAiMail, noticesSenderOf } = require("./mail");
const { createShipAiMemory } = require("./memory");
const { validateName } = require("./memory/extract");
const { createShipAiPrefsRepository } = require("./prefsRepository");
const { createShipAiTurnsRepository } = require("./turnsRepository");
const { createShipAiEventsRepository } = require("./events");
const { createProactive } = require("./proactive");
const { wingDiagText } = require("./wingHp");
const { createShipAiWatch, disabledKindsOf } = require("./watch");
const { createDscanWatch } = require("./dscan");
const { createShipAiClient } = require("./client");
const { createConversation, createDeliver } = require("./conversation");
const { buildSnapshot, createContextState, staticIndexOf } = require("./context");
const { staticLine, resolvePersona } = require("./persona");
const { validatePersonaCustom, PERSONA_CUSTOM_REASONS } = require("./personaCustom");
const { PERSONA_TEXT, PERSONA_LABELS } = require("./data/personaPresets");
const { createToolRunner } = require("./tools/loop");
const { createToolDeps } = require("./tools/deps");
const { fleetsAround, unknownDisabledTools } = require("./tools/catalog");
const { createPortraitSync, portraitDirOf } = require("./portrait");
const { createShipAiVoice, voicedDeliver, observerUrlOf } = require("./voice");
const { voiceReplyText } = require("./voice/replies");

const PERCENT = 10;
const PRESENCE_UNKNOWN_NAME = "Unknown";

function snapshotSensors(deps, M, playerId, rec, lastEventOf) {
  const out = {};
  const t = deps.telemetry(playerId);
  if (t && t.ok) {
    const p = (v) => (Number.isFinite(v) ? Math.round(v / PERCENT) : undefined);
    out.ship = { type: t.shipTypeId ? deps.typeName(t.shipTypeId) : null, shieldPct: p(t.shieldPermille),
      armorPct: p(t.armorPermille), structurePct: p(t.structurePermille), capacitorPct: p(t.capacitorPermille) };
  }
  const r = fleetsAround(deps, playerId, rec.systemId, M.threatMaxJumps);
  if (r.ok) {
    const hostile = r.entries.filter((e) => e.hostility === "hostile");
    out.threats = { here: hostile.filter((e) => e.jumps === 0).length, near: hostile.length };
  }
  const res = deps.presence();
  if (res && res.ok && Array.isArray(res.characters)) {
    out.localCount = res.characters.filter((c) => c && c.systemId === rec.systemId).length;
  }
  const npcs = typeof deps.localNpcs === "function" ? deps.localNpcs(rec.systemId) : null;
  if (npcs !== null) out.localNpcCount = npcs;
  const last = typeof lastEventOf === "function" ? lastEventOf(playerId) : null;
  if (last) out.lastEvent = last;
  return out;
}

const FAIL_REPLY = "LNE: !ai unavailable (HANDLER_FAILED)";
const MAX_REASON = 60;
const LOAD_PAGE = 256;
const INVITE_REASON = "your ship AI";
const PERSONA_SHOW_CHARS = 60;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const PANEL_SWITCHES = Object.freeze(["quiet", "alerts", "scan", "mail", "autoRoom", "autoVoice"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const safeReason = (value) => String(value ?? "unknown").replace(/[^\w:.\-]/g, "_").slice(0, MAX_REASON);
const codeOf = (err) => safeReason((err && (err.code || err.message)) || err);

function persistenceStore(persistence) {
  const p = persistence;
  return p && p.ok === true && p.store && typeof p.store.transaction === "function" ? p.store : null;
}

function createUnavailableShipAi(reason) {
  const lastError = safeReason(reason);
  const state = reason === "disabled_by_config" ? S.STATE.OFF : S.STATE.DISABLED;
  return Object.freeze({
    onRoomMessage: () => {},
    getStatus: () => ({ state, lastError, identities: 0, roomsOpen: 0,
      counters: Object.fromEntries(S.COUNTER_NAMES.map((n) => [n, 0])) }),
    stop: () => {},
  });
}

function startShipAi(deps) {
  const d = deps || {};
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : null;
  const log = (line) => {
    if (!logger) return;
    try {
      logger.log(line);
    } catch (_err) {
    }
  };
  const section = d.config && d.config.shipAi;
  if (!section || section.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const parsed = S.shipAiSettingsOf(d.config);
  if (!parsed.ok) return { ok: false, reason: "INVALID_SETTINGS", detail: parsed.detail };
  const settings = parsed.settings;
  const modelParsed = S.shipAiModelSettingsOf(d.config);
  if (!modelParsed.ok) return { ok: false, reason: "INVALID_SETTINGS", detail: modelParsed.detail };
  const M = modelParsed.settings;
  let V = null;
  if (section.voiceEnabled === true) {
    const voiceParsed = S.shipAiVoiceSettingsOf(d.config);
    if (!voiceParsed.ok) return { ok: false, reason: "INVALID_SETTINGS", detail: voiceParsed.detail };
    V = voiceParsed.settings;
  }
  let A = null;
  if (section.autostartEnabled === true) {
    const autoParsed = S.shipAiAutostartSettingsOf(d.config);
    if (!autoParsed.ok) return { ok: false, reason: "INVALID_SETTINGS", detail: autoParsed.detail };
    A = autoParsed.settings;
  }
  const store = persistenceStore(d.persistence);
  if (!store) return { ok: false, reason: "NO_PERSISTENCE_STORE" };
  const clock = d.clock && typeof d.clock.now === "function" ? d.clock : { now: () => Date.now() };
  const adapter = d.adapter;
  if (!adapter || typeof adapter.shipAiSeams !== "function" || typeof adapter.installChatCommand !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "adapter" };
  }
  const seams = adapter.shipAiSeams();
  if (!seams || !seams.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: safeReason(seams && seams.detail) };
  const seam = seams.seam;
  const isPrivate = settings.channel === "private";
  if (isPrivate && !seam.xmpp.isInstalled()) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "xmpp_tap_not_installed" };
  }
  const corp = seam.identities.corporationExists(settings.corporationId);
  if (!corp || !corp.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: safeReason(corp && corp.reason) };
  if (corp.exists !== true) return { ok: false, reason: "INVALID_SETTINGS", detail: "corporationId" };

  const repo = createShipAiPrefsRepository();
  const aiOf = new Map();
  const lastAt = new Map();
  const counters = Object.fromEntries(S.COUNTER_NAMES.map((n) => [n, 0]));
  let state = S.STATE.RUNNING;
  let channel = null;
  let commandRegistered = false;

  const register = (playerId, aiId, name) => {
    if (!isPrivate) {
      aiOf.set(playerId, Object.freeze({ aiId, name }));
      return { ok: true };
    }
    const userDataXml = seam.xmpp.userDataOf(aiId);
    if (typeof userDataXml !== "string") return { ok: false, reason: "AI_RECORD_MISSING" };
    const paired = seam.xmpp.registerPair({ playerId, aiId, userDataXml });
    if (paired && paired.ok) aiOf.set(playerId, Object.freeze({ aiId, name }));
    return paired;
  };

  const restoreRecord = (playerId, aiId, name) => {
    const written = seam.identities.writeCharacter(buildAiRecord({ aiId, name, corporationId: settings.corporationId,
      bio: settings.bio, identityKey: S.identityKeyOf(playerId) }));
    if (!written || !written.ok) return { ok: false, reason: "AI_RECORD_MISSING" };
    const flushed = seam.identities.flush(["characters"]);
    if (!flushed || !flushed.ok) return { ok: false, reason: "AI_RECORD_MISSING" };
    counters.recordsRestored += 1;
    log("shipAi: AI record restored for a player");
    return register(playerId, aiId, name);
  };

  const initialPrefs = new Map();
  const mailPrefs = new Map();
  const personaPrefs = new Map();
  const voicePrefsByPlayer = new Map();
  const autostartByPlayer = new Map();
  let missing = 0;
  for (let after = 0; ;) {
    const page = store.transaction("shipAi.load", (db) => repo.listAfter(db, after, LOAD_PAGE));
    if (!page.ok || !page.value || !page.value.ok) {
      return { ok: false, reason: "SHIP_AI_START_FAILED",
        detail: safeReason(page.ok ? page.value && page.value.reason : page.reason) };
    }
    for (const row of page.value.rows) {
      initialPrefs.set(row.playerId, { quiet: row.quiet, lastProactiveAt: row.lastProactiveAt,
        calloutMode: row.calloutMode, dscanMode: row.dscanMode, mutedKinds: row.mutedKinds,
        lastSeenAt: row.lastSeenAt });
      mailPrefs.set(row.playerId, { mailMode: row.mailMode, mailSeenId: row.mailSeenId });
      personaPrefs.set(row.playerId, { preset: row.personaPreset, custom: row.personaCustom });
      if (row.voicePrefs) voicePrefsByPlayer.set(row.playerId, row.voicePrefs);
      if (row.autostartPrefs) autostartByPlayer.set(row.playerId, row.autostartPrefs);
      if (!register(row.playerId, row.aiId, row.name).ok) missing += 1;
      after = row.playerId;
    }
    if (page.value.rows.length < LOAD_PAGE) break;
  }

  const nameOf = (playerId) => (aiOf.get(playerId) || { name: settings.defaultName }).name;

  const personaRefusedBy = Object.fromEntries(PERSONA_CUSTOM_REASONS.map((r) => [r, 0]));
  const personaOf = (playerId) => {
    const p = resolvePersona(personaPrefs.get(playerId), M.defaultPersona);
    if (p.preset !== "custom") return p;
    if (validatePersonaCustom(p.custom, M).ok) return p;
    counters.personaCustomSkipped += 1;
    return resolvePersona(null, M.defaultPersona);
  };

  const voicePrefsDeps = Object.freeze({
    get: (playerId) => voicePrefsByPlayer.get(playerId) || null,
    save: (playerId, prefs) => {
      const res = store.transaction("shipAi.voicePrefs", (db) => repo.setVoicePrefs(db, { playerId, prefs,
        nowMs: clock.now() }));
      if (!res.ok || !res.value || !res.value.ok) {
        const reason = res.ok ? res.value && res.value.reason : res.reason;
        if (reason === "NOT_FOUND") return { ok: false, reason: "NOT_PAIRED" };
        log(`shipAi: voice choice not saved - ${safeReason(reason)}`);
        return { ok: false, reason: "SAVE_FAILED" };
      }
      const saved = res.value.row.voicePrefs;
      if (saved) voicePrefsByPlayer.set(playerId, saved);
      else voicePrefsByPlayer.delete(playerId);
      return { ok: true, prefs: saved };
    },
  });
  const personaLabels = PERSONA_LABELS[M.language] || PERSONA_LABELS.en;
  const personaDeps = Object.freeze({
    view: (playerId) => {
      const stored = personaPrefs.get(playerId) || { preset: null, custom: null };
      return { preset: personaOf(playerId).preset, stored: { preset: stored.preset, custom: stored.custom },
        defaultPreset: M.defaultPersona, customMaxChars: M.personaCustomMaxChars,
        presets: S.PERSONA_PRESETS.map((id) => ({ id, label: personaLabels[id] || id })) };
    },
    apply: (playerId, req) => applyPersona(playerId, req),
  });
  const panelDeps = Object.freeze({
    stateOf: (playerId) => panelStateOf(playerId),
    applySwitch: (playerId, id, value) => applySwitch(playerId, id, value),
    invite: (playerId) => {
      if (state !== S.STATE.RUNNING) return { ok: false, reason: "NOT_RUNNING" };
      if (!S.isAllowed(settings.allow, playerId)) return { ok: false, reason: "NOT_ALLOWED" };
      return inviteForAutostart(playerId);
    },
    wing: typeof adapter.shipWingUi === "function" ? adapter.shipWingUi() : null,
    board: typeof d.getJobBoard === "function" ? d.getJobBoard : () => null,
  });

  const isAiRoom = (roomName, senderId) => {
    if (state !== S.STATE.RUNNING) return false;
    const pair = aiOf.get(senderId);
    return Boolean(pair) && String(roomName).toLowerCase() === `private_${Math.min(senderId, pair.aiId)}_`
      + `${Math.max(senderId, pair.aiId)}`;
  };

  const telemetry = d.telemetry && typeof d.telemetry.count === "function" ? d.telemetry : null;
  const keys = S.apiKeyOf(d.config);
  const client = createShipAiClient({ S: M, apiKey: keys.key, transport: d.transport, nowMs: () => clock.now(),
    telemetry, logger });
  const getter = (fn) => (typeof fn === "function" ? fn : () => null);
  let proactive = null;
  const toolDeps = createToolDeps({ adapter, sensors: seam.sensors || null, S: M, getGraph: getter(d.getGraph),
    getFleets: getter(d.getFleets), getWorld: getter(d.getWorld), getStore: () => store, db: seam.db || null,
    getBattles: getter(d.getBattles),
    getMaterialization: getter(d.getMaterialization),
    getAbyssal: getter(d.getAbyssal),
    recentEvents: (playerId, max) => (proactive ? proactive.recentEvents(playerId, max) : null) });
  const tools = createToolRunner({ client, S: M, deps: toolDeps, nowMs: () => clock.now(), telemetry });
  const sensorsOf = (playerId, rec) => snapshotSensors(toolDeps, M, playerId, rec,
    (id) => (proactive ? proactive.lastEventFor(id) : null));
  const contextState = createContextState();
  const eventsRepo = createShipAiEventsRepository(M);
  const rawDeliver = createDeliver({ pairOf: (playerId) => aiOf.get(playerId) || null, nameOf,
    sendAiMessage: isPrivate ? (spec) => seam.xmpp.sendAiMessage(spec) : null,
    readPresence: typeof adapter.readPresence === "function" ? () => adapter.readPresence() : null,
    sendCharacterSystemLine: typeof adapter.sendCharacterSystemLine === "function"
      ? (spec) => adapter.sendCharacterSystemLine(spec) : null });
  let voice = null;
  let voiceState = V ? "starting" : "off";
  if (V) {
    const started = createShipAiVoice({ S: Object.freeze({ ...V, language: M.language }), nowMs: () => clock.now(),
      randomBytes: d.randomBytes, httpRoutes: d.httpRoutes || null, observerUrl: observerUrlOf(d.config),
      telemetry, logger, aiNameOf: nameOf, piperRequest: d.piperRequest, piperTimeoutSignal: d.piperTimeoutSignal,
      voicePrefs: voicePrefsDeps, persona: personaDeps, testTimeoutSignal: d.voiceTestTimeoutSignal,
      panel: panelDeps });
    if (started.ok) {
      voice = started.voice;
      voiceState = "running";
    } else {
      voiceState = `disabled:${safeReason(started.reason)}`;
      log(`shipAi: voice off - ${safeReason(started.reason)}`);
    }
  }
  const deliver = voice ? voicedDeliver(rawDeliver, voice) : rawDeliver;
  const fcLineBreak = d.config.frontChat ? d.config.frontChat.lineBreak : undefined;
  const lineBreak = fcLineBreak === "\\n" ? "\n" : String(fcLineBreak ?? "\n");
  const turnsRepo = createShipAiTurnsRepository(M);
  const otherNames = (playerId) => {
    const res = typeof adapter.readPresence === "function" ? adapter.readPresence() : null;
    if (!res || !res.ok || !Array.isArray(res.characters)) return [];
    return res.characters.filter((c) => c && c.characterId !== playerId && typeof c.name === "string"
      && c.name !== PRESENCE_UNKNOWN_NAME).map((c) => c.name);
  };
  const memory = createShipAiMemory({ S: M, store, turnsRepo, nowMs: () => clock.now(), telemetry, logger,
    otherNames, eventsRepo });
  const snapshotOf = (playerId) => buildSnapshot({ adapter, nowMs: () => clock.now(), S: M, state: contextState,
    sensors: sensorsOf }, playerId);
  const conversation = createConversation({ S: M, client: tools, store, turnsRepo,
    nowMs: () => clock.now(), setTimer: d.setTimer, telemetry, logger, nameOf, deliver, memory, summaryClient: client,
    snapshot: snapshotOf, personaOf, onReplied: (playerId) => {
      if (proactive) proactive.onReplied(playerId);
    } });
  proactive = createProactive({ S: M, maxIdentities: settings.maxIdentities, store, prefsRepo: repo, eventsRepo,
    adapter, seam, toolDeps, client: tools, deliver, nameOf, isWatched: (playerId) => aiOf.has(playerId),
    isAllowed: (playerId) => S.isAllowed(settings.allow, playerId),
    staticIndex: () => staticIndexOf({ adapter, state: contextState }), snapshot: snapshotOf, initialPrefs,
    nowMs: () => clock.now(), setTimer: d.setTimer, telemetry, logger, getGovernor: d.getGovernor,
    personaOf,
    getNotices: getter(d.getNotices) });
  const dbSeam = seam.db || null;
  const dbAsync = (name, ...args) => {
    const refused = { ok: false, reason: "SEAM_UNAVAILABLE" };
    try {
      if (!dbSeam || typeof dbSeam[name] !== "function") return Promise.resolve(refused);
      return Promise.resolve(dbSeam[name](...args)).catch(() => refused);
    } catch (_err) {
      return Promise.resolve(refused);
    }
  };
  const watchReads = Object.freeze({
    skillHistory: (playerId, sinceMs, max) => (dbSeam && typeof dbSeam.skillHistory === "function"
      ? dbSeam.skillHistory(playerId, { sinceMs, max }) : { ok: false, reason: "SEAM_UNAVAILABLE" }),
    missionsRaw: (playerId, max) => toolDeps.missions(playerId, max, clock.now()),
    walletIncome: (playerId) => (dbSeam && typeof dbSeam.walletIncome === "function"
      ? dbSeam.walletIncome(playerId) : { ok: false, reason: "SEAM_UNAVAILABLE" }),
    skillQueueRaw: (playerId) => toolDeps.skillQueue(playerId, 1),
    jobsRaw: (playerId, max) => toolDeps.industryJobs(playerId, max, clock.now()),
    ordersRaw: (playerId, max) => dbAsync("marketOrders", playerId, { maxRows: max,
      timeoutMs: M.dbReadAsyncTimeoutMs, includeClosed: true }),
    orderState: (playerId, orderId) => dbAsync("orderState", playerId, orderId,
      { timeoutMs: M.dbReadAsyncTimeoutMs }),
    typeName: (typeId) => toolDeps.typeName(typeId),
    systemName: (systemId) => {
      const index = staticIndexOf({ adapter, state: contextState });
      const sys = index ? index.get(systemId) : null;
      return sys && typeof sys.name === "string" ? sys.name : null;
    },
  });
  const watch = createShipAiWatch({ S: M, store, eventsRepo, toolDeps: watchReads,
    readPresence: typeof adapter.readPresence === "function" ? () => adapter.readPresence() : null,
    isWatched: (playerId) => aiOf.has(playerId), isAllowed: (playerId) => S.isAllowed(settings.allow, playerId),
    isQuiet: (playerId) => proactive.isQuiet(playerId),
    offer: (playerId, events) => proactive.offerWatchEvents(playerId, events), nowMs: () => clock.now(),
    setTimer: d.setTimer, telemetry, logger, getGovernor: d.getGovernor });
  const dscanWatch = createDscanWatch({ S: M, toolDeps,
    readPresence: typeof adapter.readPresence === "function" ? () => adapter.readPresence() : null,
    isWatched: (playerId) => aiOf.has(playerId), isAllowed: (playerId) => S.isAllowed(settings.allow, playerId),
    isDscanAllowed: (playerId) => proactive.isDscanAllowed(playerId),
    calloutGroupsOf: (playerId, systemId) => proactive.calloutGroupsOf(playerId, systemId),
    offer: (playerId, reading) => proactive.offerCallout(playerId, reading), nowMs: () => clock.now(),
    setTimer: d.setTimer, logger, getGovernor: d.getGovernor });
  const unknownWatchKinds = disabledKindsOf(M).unknown;
  if (unknownWatchKinds.length > 0) {
    log(`shipAi: WARN watchDisabledKinds unknown kinds: ${unknownWatchKinds.map((n) => safeReason(n)).join(",")}`);
  }
  let mailSeam = null;
  try {
    const ms = typeof adapter.shipAiMailSeams === "function" ? adapter.shipAiMailSeams() : null;
    if (ms && ms.ok && ms.seam) mailSeam = ms.seam;
    else if (M.mailEnabled && ms) log(`shipAi: mail off - ${safeReason(ms.detail || ms.reason)}`);
  } catch (err) {
    log(`shipAi: mail off - ${codeOf(err)}`);
  }
  const isNoticesSender = noticesSenderOf(d.config && d.config.notices ? d.config.notices.senderCharacterId : 0,
    mailSeam && typeof mailSeam.senderInfo === "function" ? (id) => mailSeam.senderInfo(id) : null);
  const mail = createShipAiMail({ S: M, store, prefsRepo: repo, seam: mailSeam, client, deliver, memory, nameOf,
    snapshot: snapshotOf, isAllowed: (playerId) => S.isAllowed(settings.allow, playerId),
    aiIdOf: (playerId) => (aiOf.has(playerId) ? aiOf.get(playerId).aiId : null),
    aiIds: () => new Set([...aiOf.values()].map((p) => p.aiId)), initialPrefs: mailPrefs, personaOf,
    readPresence: typeof adapter.readPresence === "function" ? () => adapter.readPresence() : null,
    nowMs: () => clock.now(), setTimer: d.setTimer, telemetry, logger, getGovernor: d.getGovernor,
    worldNewsToldMail: (playerId, messageId) => proactive.worldNewsToldMail(playerId, messageId), isNoticesSender });
  const portraitSeam = seam.portrait && typeof seam.portrait.storeAiPortrait === "function" ? seam.portrait : null;
  const portrait = createPortraitSync({ S: M, store, repo, dir: portraitDirOf(d.config),
    storePortrait: portraitSeam ? (aiId, bytes, ext) => portraitSeam.storeAiPortrait(aiId, bytes, ext) : null,
    nowMs: () => clock.now(), defer: d.defer, logger });
  const rpm = S.sharedKeyRpmCheck(d.config, M);
  if (rpm.warn) {
    log(`shipAi: WARN chatterAi + shipAi maxRequestsPerMinute = ${rpm.sum} > ${rpm.limit} on one API key `
      + "(the free NVIDIA tier allows 40 per key)");
  }
  if (S.backgroundRpmClamped(d.config, M)) {
    log("shipAi: WARN backgroundMaxRequestsPerMinute above maxRequestsPerMinute - clamped to "
      + `${M.backgroundMaxRequestsPerMinute}`);
  }
  const unknownTools = unknownDisabledTools(M);
  if (unknownTools.length > 0) {
    log(`shipAi: WARN dbReadDisabledTools unknown names: ${unknownTools.map((n) => safeReason(n)).join(",")}`);
  }
  let autostart = null;
  const shutdown = () => {
    if (autostart) autostart.stop();
    if (voice) voice.stop();
    mail.stop();
    portrait.stop();
    watch.stop();
    dscanWatch.stop();
    proactive.stop();
    conversation.stop();
    tools.stop();
    client.stop();
  };

  function onRoomMessage(playerId, text) {
    if (state !== S.STATE.RUNNING) return;
    if (!aiOf.has(playerId)) return;
    counters.roomMessages += 1;
    if (!S.isAllowed(settings.allow, playerId)) {
      counters.roomDenied += 1;
      conversation.sendStatic(playerId, "OFFLINE");
      return;
    }
    if (String(text ?? "").trim().startsWith("!")) {
      counters.roomCommands += 1;
      const cmd = parseAiCommand(text);
      if (cmd && MEMORY_KINDS.includes(cmd.kind)) {
        deliver(playerId, runMemoryCommand(playerId, cmd));
        return;
      }
      if (cmd && QUIET_KINDS.includes(cmd.kind)) {
        deliver(playerId, [switchQuiet(playerId, cmd.kind === "quiet")]);
        return;
      }
      if (cmd && MAIL_KINDS.includes(cmd.kind)) {
        const lines = runMailCommand(playerId, cmd);
        if (lines) deliver(playerId, lines);
        return;
      }
      if (cmd && PERSONA_KINDS.includes(cmd.kind)) {
        deliver(playerId, runPersonaCommand(playerId, cmd));
        return;
      }
      if (cmd && ALERT_KINDS.includes(cmd.kind)) {
        deliver(playerId, runAlertCommand(playerId, cmd));
        return;
      }
      if (cmd && MUTE_KINDS_CMD.includes(cmd.kind)) {
        deliver(playerId, runMuteCommand(playerId, cmd));
        return;
      }
      if (cmd && AUTO_KINDS.includes(cmd.kind)) {
        deliver(playerId, runAutostartCommand(playerId, cmd));
        return;
      }
      if (cmd && cmd.kind === "voice") {
        rawDeliver(playerId, runVoiceCommand(playerId, cmd, null));
        return;
      }
      conversation.sendStatic(playerId, "HELP");
      return;
    }
    proactive.onPlayerSpoke(playerId);
    conversation.onMessage(playerId, text);
  }

  const onOffOf = (value) => {
    if (value === true || value === "on") return "on";
    if (value === false || value === "off") return "off";
    return null;
  };
  const txReason = (res) => safeReason(res.ok ? res.value && res.value.reason : res.reason);

  function writeAutostart(playerId, next) {
    const before = autostartByPlayer.get(playerId) || { room: false, voice: false };
    const res = store.transaction("shipAi.autostart", (db) => repo.setAutostart(db, { playerId, prefs: next,
      nowMs: clock.now() }));
    if (!res.ok || !res.value || !res.value.ok) {
      const reason = txReason(res);
      if (reason === "NOT_FOUND") return { ok: false, reason: "NO_PAIR" };
      log(`shipAi: autostart switch not saved - ${reason}`);
      return { ok: false, reason: "SAVE_FAILED" };
    }
    const saved = res.value.row.autostartPrefs;
    if (saved) autostartByPlayer.set(playerId, saved);
    else autostartByPlayer.delete(playerId);
    const prefs = saved || { room: false, voice: false };
    if (autostart && ((prefs.room && !before.room) || (prefs.voice && !before.voice))) autostart.forget(playerId);
    return { ok: true, prefs };
  }

  function applySwitch(playerId, id, value) {
    if (!PANEL_SWITCHES.includes(id)) return { ok: false, reason: "BAD_VALUE" };
    const v = id === "mail" ? (S.MAIL_MODES.includes(value) ? value : null) : onOffOf(value);
    if (v === null) return { ok: false, reason: "BAD_VALUE" };
    if (!aiOf.has(playerId)) return { ok: false, reason: "NO_PAIR" };
    if (id === "quiet") {
      const quiet = v === "on";
      const res = store.transaction("shipAi.quiet", (db) => repo.setQuiet(db, { playerId, quiet,
        nowMs: clock.now() }));
      if (!res.ok || !res.value || !res.value.ok) {
        log(`shipAi: quiet switch not saved - ${txReason(res)}`);
        return { ok: false, reason: "SAVE_FAILED" };
      }
      proactive.setQuiet(playerId, quiet);
      watch.setQuiet(playerId, quiet);
      if (quiet) dscanWatch.forget(playerId);
      return { ok: true, value: v };
    }
    if (id === "alerts" || id === "scan") {
      const scan = id === "scan";
      const res = store.transaction("shipAi.alerts", (db) => (scan ? repo.setDscanMode : repo.setCalloutMode)(db,
        { playerId, mode: v, nowMs: clock.now() }));
      if (!res.ok || !res.value || !res.value.ok) {
        log(`shipAi: alerts switch not saved - ${txReason(res)}`);
        return { ok: false, reason: "SAVE_FAILED" };
      }
      const row = res.value.row;
      proactive.setAlertModes(playerId, scan ? { dscanMode: row.dscanMode } : { calloutMode: row.calloutMode });
      if (v === "off") dscanWatch.forget(playerId);
      return { ok: true, value: scan ? row.dscanMode : row.calloutMode };
    }
    if (id === "mail") {
      if (!mail.available()) return { ok: false, reason: "UNAVAILABLE" };
      const r = mail.setMode(playerId, v);
      if (r.ok) return { ok: true, value: r.mode };
      return { ok: false, reason: r.reason === "NO_PAIR" ? "NO_PAIR" : "SAVE_FAILED" };
    }
    const step = id === "autoRoom" ? "room" : "voice";
    const prefs = autostartByPlayer.get(playerId) || { room: false, voice: false };
    const r = writeAutostart(playerId, { room: prefs.room, voice: prefs.voice, [step]: v === "on" });
    return r.ok ? { ok: true, value: r.prefs[step] ? "on" : "off" } : r;
  }

  function panelStateOf(playerId) {
    const modes = proactive.alertModesOf(playerId);
    const auto = autostartByPlayer.get(playerId) || { room: false, voice: false };
    const onOff = (b) => (b ? "on" : "off");
    return { paired: aiOf.has(playerId), quiet: onOff(proactive.isQuiet(playerId)), alerts: modes.calloutMode,
      scan: modes.dscanMode, mail: mail.modeOf(playerId), autoRoom: onOff(auto.room), autoVoice: onOff(auto.voice),
      autostartServer: Boolean(A && A.autostartEnabled) };
  }

  function switchQuiet(playerId, quiet) {
    try {
      if (!aiOf.has(playerId)) return "type !ai first, I have no channel to you yet";
      const r = applySwitch(playerId, "quiet", quiet);
      if (!r.ok) return r.reason === "NO_PAIR" ? "type !ai first, I have no channel to you yet"
        : "the switch failed (QUIET_FAILED)";
      return quiet ? "I will keep quiet until you type !ai talk, captain"
        : "I am back, captain. I will speak up when something happens";
    } catch (err) {
      log(`shipAi: quiet switch failed - ${codeOf(err)}`);
      return "the switch failed (HANDLER_FAILED)";
    }
  }

  function calloutDiagLines(diag) {
    const c = diag.counters;
    const n = (k) => (Number.isSafeInteger(c[k]) ? c[k] : 0);
    const s = diag.sector;
    return [`callouts ${diag.on ? "on" : "off"}: ${n("callouts")} lines (attack ${n("calloutAttack")}, grid `
      + `${n("calloutGrid")}, wave ${n("calloutWave")}, system ${n("calloutSystem")}, inbound ${n("calloutInbound")}), `
      + `suppressed ${n("calloutSuppressed")}, sensor failed ${n("calloutSensorFailed")}, scan truncated `
      + `${n("calloutScanTruncated")}`,
    s ? `last sector read ${Math.round(s.agoMs / MS_PER_SECOND)} s ago: ${s.npcs} NPC, ${s.inRange} in range, `
      + `${s.hostile} hostile, ${s.noFaction} without faction` : "no sector read yet"];
  }

  function wingDiagLines(playerId) {
    const status = typeof proactive.getStatus === "function" ? proactive.getStatus() : null;
    const wing = status && status.wing ? status.wing : null;
    const diag = typeof proactive.wingDiagOf === "function" ? proactive.wingDiagOf(playerId) : null;
    const muted = typeof proactive.mutedKindsOf === "function"
      && proactive.mutedKindsOf(playerId).own.includes("WING_HP");
    return wingDiagText(diag, { on: Boolean(wing && wing.live), marks: wing ? wing.marks : null, muted },
      M.wingHpMaxPerLine);
  }

  function runAlertCommand(playerId, cmd) {
    try {
      if (!aiOf.has(playerId)) return ["type !ai first, I have no channel to you yet"];
      if (cmd.kind === "wing") return wingDiagLines(playerId);
      const scan = cmd.kind === "scan" || cmd.kind === "scanMode";
      if (cmd.kind === "alertsMode" || cmd.kind === "scanMode") {
        const r = applySwitch(playerId, scan ? "scan" : "alerts", cmd.mode);
        if (!r.ok) {
          return [r.reason === "NO_PAIR" ? "type !ai first, I have no channel to you yet"
            : "the switch failed (ALERTS_FAILED)"];
        }
      }
      const modes = proactive.alertModesOf(playerId);
      const kind = scan ? (modes.dscanMode === "off" ? "SCAN_OFF" : "SCAN_ON")
        : (modes.calloutMode === "off" ? "ALERTS_OFF" : "ALERTS_ON");
      const lines = [staticLine(kind, M.language, playerId, personaOf(playerId).preset)];
      if (cmd.kind === "alerts" && typeof proactive.calloutDiagOf === "function") {
        lines.push(...calloutDiagLines(proactive.calloutDiagOf(playerId)));
      }
      return lines;
    } catch (err) {
      log(`shipAi: alerts switch failed - ${codeOf(err)}`);
      return ["the switch failed (HANDLER_FAILED)"];
    }
  }

  function runMuteCommand(playerId, cmd) {
    const T = MUTE_TEXT[M.language] || MUTE_TEXT.en;
    const fillT = (text, values) => text.replace(/\{(kind|kinds)\}/g, (_m, k) => String(values[k]));
    try {
      if (!aiOf.has(playerId)) return [T.first];
      const now = proactive.mutedKindsOf(playerId);
      if (cmd.kind === "muteList") {
        const all = [...new Set([...now.own, ...now.global])].sort();
        return [all.length > 0 ? fillT(T.list, { kinds: all.join(", ") }) : T.none];
      }
      const all = cmd.kind === "unmute" && cmd.target === "ALL";
      if (!all && !S.MUTE_KINDS.includes(cmd.target)) {
        return [fillT(T.unknown, { kind: String(cmd.target).slice(0, 24), kinds: S.MUTE_KINDS.join(", ") })];
      }
      let kinds = now.own.filter((k) => k !== cmd.target);
      if (cmd.kind === "mute") kinds = [...kinds, cmd.target];
      if (all) kinds = [];
      const res = store.transaction("shipAi.mute", (db) => repo.setMutedKinds(db, { playerId, kinds,
        nowMs: clock.now() }));
      if (!res.ok || !res.value || !res.value.ok) {
        log(`shipAi: mute not saved - ${safeReason(res.ok ? res.value && res.value.reason : res.reason)}`);
        return [T.failed];
      }
      proactive.setMutedKinds(playerId, res.value.row.mutedKinds);
      if (all) return [T.unmutedAll];
      return [fillT(cmd.kind === "mute" ? T.muted : T.unmuted, { kind: cmd.target })];
    } catch (err) {
      log(`shipAi: mute command failed - ${codeOf(err)}`);
      return [T.failed];
    }
  }

  function runAutostartCommand(playerId, cmd) {
    const first = "type !ai first, I have no channel to you yet";
    try {
      if (!aiOf.has(playerId)) return [first];
      if (cmd.kind === "autoMode") {
        const r = cmd.target === "all" ? writeAutostart(playerId, { room: cmd.on, voice: cmd.on })
          : applySwitch(playerId, cmd.target === "room" ? "autoRoom" : "autoVoice", cmd.on);
        if (!r.ok) return [r.reason === "NO_PAIR" ? first : "the switch failed (AUTOSTART_FAILED)"];
      }
      const prefs = autostartByPlayer.get(playerId) || { room: false, voice: false };
      const onOff = (v) => (v ? "on" : "off");
      const serverOff = A && A.autostartEnabled ? "" : " - the autostart is off on this server";
      return [`autostart: room ${onOff(prefs.room)}, voice ${onOff(prefs.voice)} (after login: the invitation and `
        + `the voice link)${serverOff}`];
    } catch (err) {
      log(`shipAi: autostart command failed - ${codeOf(err)}`);
      return ["the switch failed (HANDLER_FAILED)"];
    }
  }

  function runMailCommand(playerId, cmd) {
    try {
      if (cmd.kind === "mailMode") {
        if (!mail.available()) return [mail.statusLine(playerId)];
        const r = applySwitch(playerId, "mail", cmd.mode);
        return [mail.modeLine(r.ok ? { ok: true, mode: r.value }
          : { ok: false, reason: r.reason === "NO_PAIR" ? "NO_PAIR" : "MAIL_FAILED" })];
      }
      if (cmd.kind === "mailAsk") return mail.ask(playerId, cmd.n, cmd.text).lines;
      return [mail.statusLine(playerId)];
    } catch (err) {
      log(`shipAi: mail command failed - ${codeOf(err)}`);
      return ["mail unavailable (HANDLER_FAILED)"];
    }
  }

  function applyPersona(playerId, req) {
    if (!aiOf.has(playerId)) return { ok: false, reason: "NOT_PAIRED" };
    const r = req || {};
    const save = (preset, custom) => {
      const res = store.transaction("shipAi.persona", (db) => repo.setPersona(db, { playerId, preset, custom,
        nowMs: clock.now() }));
      if (!res.ok || !res.value || !res.value.ok) {
        log(`shipAi: persona switch not saved - ${safeReason(res.ok ? res.value && res.value.reason : res.reason)}`);
        return { ok: false, reason: "SAVE_FAILED" };
      }
      const row = res.value.row;
      personaPrefs.set(playerId, { preset: row.personaPreset, custom: row.personaCustom });
      counters.personaChanges += 1;
      return { ok: true, preset: row.personaPreset, custom: row.personaCustom };
    };
    if (r.action === "reset") return save(null, null);
    if (r.action === "set") {
      if (!S.PERSONA_PRESETS.includes(r.preset) || r.preset === "custom") return { ok: false, reason: "UNKNOWN_PRESET" };
      return save(r.preset, undefined);
    }
    const fromStore = typeof r.text !== "string" || r.text === "";
    const stored = personaPrefs.get(playerId);
    if (fromStore && (!stored || typeof stored.custom !== "string" || stored.custom === "")) {
      return { ok: false, reason: "NO_CUSTOM" };
    }
    const checked = validatePersonaCustom(fromStore ? stored.custom : r.text, M);
    if (!checked.ok) {
      counters.personaRefused += 1;
      if (Object.prototype.hasOwnProperty.call(personaRefusedBy, checked.reason)) {
        personaRefusedBy[checked.reason] += 1;
      }
      return { ok: false, reason: checked.reason };
    }
    return save("custom", fromStore ? undefined : checked.text);
  }

  function runPersonaCommand(playerId, cmd) {
    const T = PERSONA_TEXT[M.language] || PERSONA_TEXT.en;
    const fillT = (text, values) => text.replace(/\{(preset|text|max|reason)\}/g, (_m, k) => String(values[k]));
    counters.personaCommands += 1;
    try {
      if (!aiOf.has(playerId)) return [T.first];
      if (cmd.action === "show") {
        const p = personaOf(playerId);
        return [p.preset === "custom" ? fillT(T.showCustom, { text: p.custom.slice(0, PERSONA_SHOW_CHARS) })
          : fillT(T.show, { preset: p.preset })];
      }
      if (cmd.action === "list") return [fillT(T.list, { max: M.personaCustomMaxChars })];
      const res = applyPersona(playerId, cmd);
      if (res.ok) {
        if (cmd.action === "reset") return [fillT(T.reset, { preset: M.defaultPersona })];
        return [cmd.action === "set" ? T.set[cmd.preset] : T.customSet];
      }
      if (res.reason === "NOT_PAIRED") return [T.first];
      if (res.reason === "UNKNOWN_PRESET") return [T.unknown];
      if (res.reason === "NO_CUSTOM") return [fillT(T.customUsage, { max: M.personaCustomMaxChars })];
      if (res.reason === "SAVE_FAILED") return [T.failed];
      return [fillT(T.customRefused, { reason: res.reason })];
    } catch (err) {
      log(`shipAi: persona command failed - ${codeOf(err)}`);
      return [T.failed];
    }
  }

  function runVoiceCommand(playerId, cmd, characterName) {
    try {
      if (!V) return voiceReplyText("VOICE_OFF", M.language);
      if (!voice) return voiceReplyText("UNAVAILABLE", M.language, { detail: voiceState.toUpperCase() });
      if (cmd.action === "off") return voiceReplyText(voice.off(playerId).ended ? "OFF_DONE" : "OFF_NONE", M.language);
      if (cmd.action === "status") {
        return voiceReplyText(voice.statusOf(playerId).listening ? "STATUS_ON" : "STATUS_OFF", M.language);
      }
      const r = voice.link(playerId, characterName);
      if (!r.ok) return voiceReplyText(r.reason, M.language, { waitMs: r.waitMs });
      return voiceReplyText("LINK", M.language, { href: r.href, ttlMs: r.ttlMs });
    } catch (err) {
      log(`shipAi: voice command failed - ${codeOf(err)}`);
      return voiceReplyText("UNAVAILABLE", M.language, { detail: "HANDLER_FAILED" });
    }
  }

  const refusalReply = (reason) => `LNE: !ai failed (${safeReason(reason)})`;

  function inviteForAutostart(playerId) {
    const id = ensureIdentity({ store, repo, settings, identities: seam.identities, nowMs: () => clock.now() },
      playerId);
    if (!id.ok) {
      log(`shipAi: identity refused - ${safeReason(id.reason)}:${safeReason(id.detail)}`);
      return { ok: false, reason: safeReason(id.reason) };
    }
    if (id.created) log(`shipAi: identity created for a player (identities=${aiOf.size + 1})`);
    proactive.noteIdentity(playerId);
    mail.onPairAdded(playerId);
    portrait.syncSoon(playerId);
    let registered = register(playerId, id.aiId, id.name);
    if (!registered.ok && registered.reason === "AI_RECORD_MISSING") {
      registered = restoreRecord(playerId, id.aiId, id.name);
    }
    if (!isPrivate) return { ok: false, reason: "NOT_PRIVATE", name: id.name };
    if (!registered.ok) return { ok: false, reason: safeReason(registered.reason) };
    const room = channel.ensureRoom(playerId, id.aiId);
    if (!room.ok) {
      log(`shipAi: room refused - ${safeReason(room.reason)}:${safeReason(room.detail)}`);
      return { ok: false, reason: safeReason(room.reason) };
    }
    const invited = channel.invite(playerId, id.aiId, `${id.name}: ${INVITE_REASON}`);
    if (!invited.ok) return { ok: false, reason: safeReason(invited.reason) };
    counters.invites += 1;
    return { ok: true, name: id.name };
  }

  function openRoom(playerId) {
    const r = inviteForAutostart(playerId);
    if (r.ok) return `${r.name}: invitation sent, accept it to talk`;
    if (r.reason === "IDENTITY_LIMIT") return `${settings.defaultName}: no free ship AI on this server (IDENTITY_LIMIT)`;
    if (r.reason === "NOT_PRIVATE") return `${r.name}: the private channel is off on this server (shipAi.channel=local)`;
    return refusalReply(r.reason);
  }

  function voiceLinkForAutostart(playerId, characterName) {
    if (!V || !voice) return { ok: false, reason: "VOICE_OFF" };
    const r = voice.link(playerId, characterName);
    if (!r || !r.ok) return { ok: false, reason: safeReason(r && r.reason) };
    return { ok: true, lines: voiceReplyText("LINK", M.language, { href: r.href, ttlMs: r.ttlMs }) };
  }

  function handle(rec, text, ctx) {
    if (state !== S.STATE.RUNNING) return `LNE: !ai unavailable (${state.toUpperCase()})`;
    if (!rec || !isId(rec.characterId)) return "LNE: !ai unavailable (NO_CHARACTER)";
    const playerId = rec.characterId;
    const name = nameOf(playerId);
    if (!S.isAllowed(settings.allow, playerId)) {
      counters.denied += 1;
      return `${name}: the ship AI is not enabled for you on this server`;
    }
    if (!ctx || ctx.transport !== S.TRANSPORT_PRIVATE) {
      counters.refusedNotPrivate += 1;
      return `${name}: private chat only on this chat path (NOT_PRIVATE)`;
    }
    const now = clock.now();
    const last = lastAt.get(playerId);
    if (last !== undefined && now - last < settings.minIntervalMs) {
      return `${name}: wait ${Math.ceil((settings.minIntervalMs - (now - last)) / 1000)}s before the next !ai`;
    }
    for (const [id, at] of lastAt) {
      if (now - at >= settings.minIntervalMs) lastAt.delete(id);
    }
    lastAt.set(playerId, now);
    const cmd = parseAiCommand(text);
    if (!cmd || cmd.kind === "help") {
      return `${name}: !ai - invitation to our private channel; !ai <text> - a word to me; !ai memory | remember `
        + "<text> | forget <#id|text> | forget all - what I remember; !ai name <name> - rename me; !ai quiet | talk - "
        + "I keep quiet / speak up on my own; !ai mail on | quiet | off | <n> [question] - your EVE mail; "
        + "!ai voice [on] | off | status - my lines read aloud in your browser; "
        + "!ai persona [list | <name> | custom <text> | reset] - my personality; "
        + "!ai alerts on | off - hostile callouts; !ai scan on | off - automatic d-scan; "
        + "!ai wing - the HP alerts of your ship wing copies (state); "
        + "!ai mute [<kind>] | unmute <kind> | unmute all - silence one kind of my lines; "
        + "!ai auto [on | off | room on|off | voice on|off] - the invitation and the voice link by myself after login; "
        + "!ai help - this text";
    }
    if (cmd.kind === "voice") {
      return `${name}: ${runVoiceCommand(playerId, cmd, typeof rec.name === "string" ? rec.name : null)
        .join(lineBreak)}`;
    }
    if (MEMORY_KINDS.includes(cmd.kind)) {
      const lines = runMemoryCommand(playerId, cmd);
      return `${nameOf(playerId)}: ${lines.join(" | ")}`;
    }
    if (QUIET_KINDS.includes(cmd.kind)) return `${name}: ${switchQuiet(playerId, cmd.kind === "quiet")}`;
    if (PERSONA_KINDS.includes(cmd.kind)) return `${name}: ${runPersonaCommand(playerId, cmd).join(" | ")}`;
    if (ALERT_KINDS.includes(cmd.kind)) return `${name}: ${runAlertCommand(playerId, cmd).join(" | ")}`;
    if (MUTE_KINDS_CMD.includes(cmd.kind)) return `${name}: ${runMuteCommand(playerId, cmd).join(" | ")}`;
    if (AUTO_KINDS.includes(cmd.kind)) return `${name}: ${runAutostartCommand(playerId, cmd).join(" | ")}`;
    if (MAIL_KINDS.includes(cmd.kind)) {
      const lines = runMailCommand(playerId, cmd);
      return `${name}: ${lines ? lines.join(" | ")
        : staticLine("ACK", M.language, playerId, personaOf(playerId).preset)}`;
    }
    if (cmd.kind === "say") {
      proactive.onPlayerSpoke(playerId);
      conversation.onMessage(playerId, cmd.text);
      return `${name}: ${staticLine("ACK", M.language, playerId, personaOf(playerId).preset)}`;
    }
    return openRoom(playerId);
  }

  const forgetDeadline = new Map();
  const renamedAt = new Map();

  function rename(playerId, wanted) {
    if (wanted === "") return ["usage: !ai name <name> (2-24 letters, spaces or hyphens)"];
    const pair = aiOf.get(playerId);
    if (!pair) return ["type !ai first, I have no channel to you yet"];
    const checked = validateName(wanted, M);
    if (!checked.ok) return [`I cannot take that name (${checked.reason})`];
    const now = clock.now();
    const last = renamedAt.get(playerId);
    if (last !== undefined && now - last < M.renameCooldownMs) {
      return [`one new name per ${Math.ceil(M.renameCooldownMs / MS_PER_MINUTE)} min, `
        + `wait ${Math.ceil((M.renameCooldownMs - (now - last)) / MS_PER_MINUTE)} min`];
    }
    const written = seam.identities.writeCharacter(buildAiRecord({ aiId: pair.aiId, name: checked.name,
      corporationId: settings.corporationId, bio: settings.bio, identityKey: S.identityKeyOf(playerId) }));
    const flushed = written && written.ok ? seam.identities.flush(["characters"]) : null;
    if (!flushed || !flushed.ok) {
      log(`shipAi: rename refused - ${safeReason((written && !written.ok ? written : flushed || {}).reason)}`);
      return ["the rename failed (RENAME_FAILED)"];
    }
    const res = store.transaction("shipAi.rename", (db) => repo.updateName(db, { playerId, name: checked.name,
      nowMs: now }));
    if (!res.ok || !res.value || !res.value.ok) {
      log(`shipAi: rename not saved - ${safeReason(res.ok ? res.value && res.value.reason : res.reason)}`);
      const back = seam.identities.writeCharacter(buildAiRecord({ aiId: pair.aiId, name: pair.name,
        corporationId: settings.corporationId, bio: settings.bio, identityKey: S.identityKeyOf(playerId) }));
      const backFlushed = back && back.ok ? seam.identities.flush(["characters"]) : null;
      if (!backFlushed || !backFlushed.ok) log("shipAi: rename rollback failed - RECORD_NOT_RESTORED");
      return ["the rename failed (RENAME_FAILED)"];
    }
    for (const [id, at] of renamedAt) {
      if (now - at >= M.renameCooldownMs) renamedAt.delete(id);
    }
    renamedAt.set(playerId, now);
    register(playerId, pair.aiId, checked.name);
    counters.renames += 1;
    log("shipAi: AI renamed for a player");
    return [`call me ${checked.name} from now on`];
  }

  function runMemoryCommand(playerId, cmd) {
    counters.memoryCommands += 1;
    try {
      if (cmd.kind === "name") return rename(playerId, cmd.name);
      const wipe = cmd.kind === "forgetAll" || cmd.kind === "forgetAllConfirm";
      if (!memory.enabled && !wipe) return ["my long memory is off on this server"];
      const now = clock.now();
      if (cmd.kind === "memory") {
        const r = memory.list(playerId);
        if (!r.ok) return [`memory unavailable (${r.reason})`];
        if (r.facts.length === 0) return ["I keep no facts about you yet"];
        return r.facts.map((f) => `#${f.id} ${f.category}: ${f.content}`);
      }
      if (cmd.kind === "remember") {
        if (cmd.text === "") return ["usage: !ai remember <text> (or <category>: <text>)"];
        const r = memory.remember(playerId, cmd.text);
        return [r.ok ? `noted (#${r.id})` : `I cannot keep that (${r.reason})`];
      }
      if (cmd.kind === "forget") {
        if (cmd.id === undefined && cmd.text === "") return ["usage: !ai forget <#id|text> or !ai forget all"];
        const r = memory.forget(playerId, cmd.id !== undefined ? cmd.id : cmd.text);
        if (!r.ok) return [`forget failed (${r.reason})`];
        return [r.deleted > 0 ? `forgotten (${r.deleted})` : "I keep no such fact"];
      }
      if (cmd.kind === "forgetAll") {
        for (const [id, at] of forgetDeadline) {
          if (at < now) forgetDeadline.delete(id);
        }
        forgetDeadline.set(playerId, now + M.forgetConfirmMs);
        return [`this deletes our conversation and everything I remember about you. Type !ai forget all confirm `
          + `within ${Math.ceil(M.forgetConfirmMs / MS_PER_SECOND)} s`];
      }
      const deadline = forgetDeadline.get(playerId);
      forgetDeadline.delete(playerId);
      if (deadline === undefined || now > deadline) return ["type !ai forget all first"];
      const r = memory.forgetAll(playerId);
      if (r.ok) {
        proactive.forget(playerId);
        watch.forget(playerId);
        dscanWatch.forget(playerId);
      }
      return [r.ok ? "done, I remember nothing about you now" : `forget failed (${r.reason})`];
    } catch (err) {
      log(`shipAi: memory command failed - ${codeOf(err)}`);
      return ["memory unavailable (HANDLER_FAILED)"];
    }
  }

  function stop(reason) {
    if (state === S.STATE.STOPPED) return;
    state = S.STATE.STOPPED;
    if (channel) channel.uninstall();
    if (commandRegistered) {
      try {
        adapter.uninstallChatCommand(S.COMMAND_NAME);
      } catch (err) {
        log(`shipAi: !ai uninstall failed - ${codeOf(err)}`);
      }
      commandRegistered = false;
    }
    if (isPrivate) seam.xmpp.clearPairs();
    shutdown();
    log(`shipAi: stopped (${safeReason(reason || "stop")})`);
  }

  if (isPrivate) {
    channel = seam.channel({ isAiRoom, onRoomMessage });
    const wrapped = channel.install();
    if (!wrapped.ok) {
      seam.xmpp.clearPairs();
      shutdown();
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: safeReason(wrapped.reason) };
    }
  }
  let installed;
  try {
    installed = adapter.installChatCommand({ name: S.COMMAND_NAME, match: (t) => S.COMMAND_RE.test(String(t)),
      handle, failReply: FAIL_REPLY });
  } catch (err) {
    installed = { ok: false, reason: codeOf(err) };
  }
  if (!installed || !installed.ok) {
    if (channel) channel.uninstall();
    if (isPrivate) seam.xmpp.clearPairs();
    shutdown();
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: safeReason(installed && installed.reason) };
  }
  commandRegistered = true;
  if (A) {
    const systemDeliver = createDeliver({ pairOf: () => null, nameOf,
      readPresence: typeof adapter.readPresence === "function" ? () => adapter.readPresence() : null,
      sendCharacterSystemLine: typeof adapter.sendCharacterSystemLine === "function"
        ? (spec) => adapter.sendCharacterSystemLine(spec) : null });
    autostart = createShipAiAutostart({ S: A, nowMs: () => clock.now(), setTimer: d.setTimer,
      readPresence: typeof adapter.readPresence === "function" ? () => adapter.readPresence() : () => null,
      prefsOf: (playerId) => autostartByPlayer.get(playerId) || null, anyEnabled: () => autostartByPlayer.size > 0,
      isAllowed: (playerId) => S.isAllowed(settings.allow, playerId) && aiOf.has(playerId),
      isRunning: () => state === S.STATE.RUNNING, invite: inviteForAutostart, voiceLink: voiceLinkForAutostart,
      sendSystem: systemDeliver, telemetry, log });
  }
  proactive.start();
  watch.start();
  dscanWatch.start();
  mail.start();
  if (autostart) autostart.start();
  portrait.bootPass([...initialPrefs.keys()]);
  const missingNote = missing > 0 ? ` missing=${missing}` : "";
  log(`shipAi: running - channel=${settings.channel} identities=${aiOf.size}${missingNote} model=${M.model} `
    + `language=${M.language} apiKeySet=${keys.key !== ""} maxRequestsPerMinute=${M.maxRequestsPerMinute} `
    + `toolMode=${M.toolMode} proactive=${proactive.getStatus().state} portrait=${portrait.getStatus().state} `
    + `mail=${mail.getStatus().state} voice=${voiceState} watch=${watch.getStatus().state}`);

  function personaStatus() {
    const byPreset = {};
    for (const playerId of aiOf.keys()) {
      const preset = resolvePersona(personaPrefs.get(playerId), M.defaultPersona).preset;
      byPreset[preset] = (byPreset[preset] || 0) + 1;
    }
    return { defaultPreset: M.defaultPersona, byPreset, refused: { ...personaRefusedBy } };
  }

  function getStatus() {
    const xs = isPrivate ? seam.xmpp.getState() : null;
    return { state, identities: aiOf.size, roomsOpen: xs ? xs.rooms : 0, counters: { ...counters },
      model: client.getStatus(), conversation: conversation.getStatus(), tools: tools.getStatus(),
      memory: memory.getStatus(), proactive: proactive.getStatus(), portrait: portrait.getStatus(),
      mail: mail.getStatus(), voice: voice ? voice.getStatus() : { state: voiceState }, watch: watch.getStatus(),
      dscan: dscanWatch.getStatus(), persona: personaStatus(),
      autostart: autostart ? autostart.getStatus() : { state: "off", tracked: 0, counters: {} } };
  }

  return { ok: true, shipAi: Object.freeze({ onRoomMessage, getStatus, stop, handle }) };
}

module.exports = { startShipAi, createUnavailableShipAi, COMMAND_NAME: S.COMMAND_NAME, COMMAND_RE: S.COMMAND_RE };
