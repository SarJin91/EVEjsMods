"use strict";

const { createPoller } = require("../presence/poller");
const { createRng, deriveSeed } = require("../util/rng");
const { STATE, LANE_STATE, TALK_COUNTER_NAMES, npcVoicesSettingsOf, localSettingsOf, siteSettingsOf,
  talkSettingsOf } = require("./schema");
const { createTranscript } = require("./talk/transcript");
const { createTalkLane } = require("./talk/lane");
const { createLocalLane, systemNameOf } = require("./localLane");
const { createSiteLane, formatSiteLine } = require("./siteLane");
const { pickVoiceLine } = require("./lines");
const { glyphLine, alphabetOf } = require("./glyphs");
const { ALPHABETS, EXTENDED_ALPHABETS } = require("./data/glyphs");
const { GLYPH_VOICES, SPEAKERS, COLORS } = require("./data/voices");

const MAX_DETAIL = 120;
const COMMAND_RE = /^!\s*npcvoices(?:\s[\s\S]*)?$/i;
const COMMAND_NAME = "npcvoices";
const FAIL_REPLY = "LNE: !npcvoices unavailable (HANDLER_FAILED)";
const SAMPLE_HEADER = "NPC voices sample (glyphs, static lines, extended signs):";
const SAMPLE_AI_VOICES = Object.freeze(["GURISTAS", "AMARR", "TRIGLAVIAN"]);
const SAMPLE_CONTEXT = "SITE_ARRIVAL";
const SAMPLE_SEED = 11361;
const SAMPLE_EXTENDED_SIGNS = 8;
const SAMPLE_PILOT = "Capsuleer";
const SITE_SEAM_UNAVAILABLE = "SITE_SEAM_UNAVAILABLE";
const TALK_SEAM_UNAVAILABLE = "TALK_SEAM_UNAVAILABLE";
const TALK_NEEDS_LOCAL = "TALK_NEEDS_LOCAL";

function noop() {}

function soft(getter) {
  try {
    return typeof getter === "function" ? getter() || null : null;
  } catch (_err) {
    return null;
  }
}

function codeOf(err) {
  const code = err && err.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "ERROR";
}

function safeReason(reason) {
  return String(reason || "unavailable").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, MAX_DETAIL);
}

function createOffNpcVoices() {
  return Object.freeze({
    noteFactionCrews: noop,
    getStatus: () => ({ state: STATE.OFF }),
    stop: noop,
  });
}

function createUnavailableNpcVoices(reason) {
  const lastError = safeReason(reason);
  return Object.freeze({
    noteFactionCrews: noop,
    getStatus: () => ({ state: STATE.DISABLED, lastError }),
    stop: noop,
  });
}

function startNpcVoices(deps) {
  try {
    const config = (deps && deps.config) || {};
    const V = config.npcVoices;
    if (!V || V.enabled !== true) return { ok: true, npcVoices: createOffNpcVoices() };
    return { ok: true, npcVoices: createNpcVoicesService(deps, config) };
  } catch (err) {
    return { ok: false, reason: "NPC_VOICES_START_FAILED", detail: codeOf(err) };
  }
}

function createNpcVoicesService(deps, config) {
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : null;
  const telemetry = deps.telemetry && typeof deps.telemetry.count === "function" ? deps.telemetry : null;
  const logged = new Set();
  let state = STATE.RUNNING;
  let lastError = null;
  const local = { state: LANE_STATE.OFF, lastError: null, lane: null, poller: null };
  const site = { state: LANE_STATE.OFF, lastError: null, lane: null, poller: null, hooked: false };
  const command = { state: "off", reason: null };
  const talk = { state: LANE_STATE.OFF, lastError: null, transcript: null, seam: null, tapped: false, lane: null,
    poller: null, counters: Object.fromEntries(TALK_COUNTER_NAMES.map((n) => [n, 0])) };

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }
  function logOnce(key, line) {
    if (logged.has(key)) return;
    logged.add(key);
    log(line);
  }
  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function sendLocal(spec) {
    const adapter = deps.adapter;
    const seams = adapter && typeof adapter.localPilotsSeams === "function" ? adapter.localPilotsSeams() : null;
    const seam = seams && seams.ok === true ? seams.seam : null;
    return seam && typeof seam.sendOccupantMessage === "function" ? seam.sendOccupantMessage(spec)
      : { ok: false, reason: "NOT_INSTALLED" };
  }

  function disableLocal(code) {
    local.state = LANE_STATE.DISABLED;
    local.lastError = safeReason(code);
    if (local.poller) local.poller.stop();
    if (local.lane) local.lane.clear();
    logOnce(`LOCAL_${local.lastError}`, `npcVoices: local lane disabled - ${local.lastError}`);
  }

  function localPass() {
    if (state !== STATE.RUNNING || local.state !== LANE_STATE.RUNNING) return;
    try {
      local.lane.pass();
    } catch (err) {
      local.lane.bump("errors");
      disableLocal(`PASS_FAILED:${codeOf(err)}`);
    }
  }

  function unhookSite() {
    if (!site.hooked) return;
    site.hooked = false;
    try {
      deps.adapter.uninstallSiteEntryHook();
    } catch (err) {
      log(`npcVoices: site hook uninstall failed - ${codeOf(err)}`);
    }
  }

  function disableSite(code) {
    site.state = LANE_STATE.DISABLED;
    site.lastError = safeReason(code);
    if (site.poller) site.poller.stop();
    unhookSite();
    if (site.lane) site.lane.clear();
    logOnce(`SITE_${site.lastError}`, `npcVoices: site lane disabled - ${site.lastError}`);
  }

  function sitePass() {
    if (state !== STATE.RUNNING || site.state !== LANE_STATE.RUNNING) return;
    try {
      site.lane.pass();
    } catch (err) {
      site.lane.bump("errors");
      disableSite(`PASS_FAILED:${codeOf(err)}`);
    }
  }

  function onSiteEnter(ev) {
    if (state !== STATE.RUNNING || site.state !== LANE_STATE.RUNNING) return;
    try {
      site.lane.noteEntry({ ...ev, atMs: clock.now() });
    } catch (_err) {
      site.lane.bump("errors");
    }
  }

  function sendSiteLine(spec) {
    const adapter = deps.adapter;
    return adapter && typeof adapter.sendCharacterSystemLine === "function" ? adapter.sendCharacterSystemLine(spec)
      : { ok: false, reason: "SEAM_UNAVAILABLE" };
  }

  function startSite(V) {
    const S = siteSettingsOf(config);
    const adapter = deps.adapter;
    if (S.ok && S.settings.enabled !== true) {
      site.state = LANE_STATE.OFF;
      return;
    }
    if (!S.ok) {
      disableSite(`INVALID_SETTINGS:${S.detail}`);
      return;
    }
    if (!Number.isSafeInteger(deps.worldSeed)) {
      disableSite("NO_WORLD_SEED");
      return;
    }
    if (!adapter || typeof adapter.installSiteEntryHook !== "function"
      || typeof adapter.sendCharacterSystemLine !== "function") {
      disableSite(SITE_SEAM_UNAVAILABLE);
      return;
    }
    site.lane = createSiteLane({ S: S.settings, V, worldSeed: deps.worldSeed, now: () => clock.now(), metric,
      send: sendSiteLine, getChatterAi: deps.getChatterAi, getGraph: deps.getGraph });
    let hooked = null;
    try {
      hooked = adapter.installSiteEntryHook(onSiteEnter);
    } catch (err) {
      hooked = { ok: false, reason: "THREW", detail: codeOf(err) };
    }
    if (!hooked || hooked.ok !== true) {
      const why = hooked ? `${hooked.reason}${hooked.detail ? `:${hooked.detail}` : ""}` : "no_result";
      log(`npcVoices: site entry hook refused - ${safeReason(why)}`);
      disableSite(SITE_SEAM_UNAVAILABLE);
      return;
    }
    site.hooked = true;
    site.poller = createPoller({ runPass: sitePass, intervalMs: S.settings.tickMs, now: () => clock.now(),
      setTimer: deps.setTimer, onError: (err) => disableSite(`TIMER_FAILED:${codeOf(err)}`) });
    site.state = LANE_STATE.RUNNING;
    site.poller.start();
  }

  function untapTalk() {
    if (!talk.tapped) return;
    talk.tapped = false;
    try {
      talk.seam.uninstallTap();
    } catch (err) {
      log(`npcVoices: talk tap uninstall failed - ${codeOf(err)}`);
    }
  }

  function unmuteLocal() {
    if (local.lane && local.state === LANE_STATE.RUNNING) local.lane.setMuted(false);
  }

  function quietTalk() {
    if (talk.poller) talk.poller.stop();
    if (talk.lane) talk.lane.clear();
  }

  function disableTalk(code) {
    talk.state = LANE_STATE.DISABLED;
    talk.lastError = safeReason(code);
    quietTalk();
    untapTalk();
    if (talk.transcript) talk.transcript.clear();
    unmuteLocal();
    logOnce(`TALK_${talk.lastError}`, `npcVoices: talk lane disabled - ${talk.lastError}`);
  }

  function onTalkLine(line) {
    if (state !== STATE.RUNNING || talk.state !== LANE_STATE.RUNNING) return;
    try {
      talk.counters[line.kind === "player" ? "playerLines" : "npcLines"] += 1;
      const noted = { ...line, atMs: clock.now() };
      const ok = talk.transcript.note(noted);
      talk.counters[ok ? "noted" : "skipped"] += 1;
      if (ok && talk.lane) talk.lane.onLine(noted);
    } catch (_err) {
      talk.counters.errors += 1;
    }
  }

  function talkPass() {
    if (state !== STATE.RUNNING || talk.state !== LANE_STATE.RUNNING || !talk.lane) return;
    try {
      talk.lane.pass();
    } catch (err) {
      talk.counters.errors += 1;
      disableTalk(`PASS_FAILED:${codeOf(err)}`);
    }
  }

  function noteTalkSystems(bySystem) {
    if (talk.state !== LANE_STATE.RUNNING || !(bySystem instanceof Map)) return;
    try {
      const ids = [];
      for (const [systemId, list] of bySystem) if (Array.isArray(list) && list.length > 0) ids.push(systemId);
      talk.transcript.setSystems(ids);
      if (talk.lane) talk.lane.noteCrews(bySystem);
      talk.counters.notes += 1;
    } catch (err) {
      disableTalk(`NOTE_FAILED:${codeOf(err)}`);
    }
  }

  function startTalk(V) {
    const T = talkSettingsOf(config);
    if (T.ok && T.settings.enabled !== true) {
      talk.state = LANE_STATE.OFF;
      return;
    }
    if (!T.ok) {
      disableTalk(`INVALID_SETTINGS:${T.detail}`);
      return;
    }
    const P = config.localPilots;
    if (!P || P.enabled !== true) {
      talk.state = LANE_STATE.DISABLED_BY_DEPENDENCY;
      talk.lastError = "localPilots";
      return;
    }
    const L = config.npcVoices.local;
    if (!L || L.enabled !== true) {
      disableTalk(TALK_NEEDS_LOCAL);
      return;
    }
    if (!Number.isSafeInteger(deps.worldSeed)) {
      disableTalk("NO_WORLD_SEED");
      return;
    }
    const adapter = deps.adapter;
    let seams = null;
    try {
      seams = adapter && typeof adapter.localTalkSeams === "function" ? adapter.localTalkSeams() : null;
    } catch (_err) {
      seams = null;
    }
    if (!seams || seams.ok !== true || !seams.seam) {
      if (seams && seams.reason) log(`npcVoices: talk seam refused - ${safeReason(seams.detail || seams.reason)}`);
      talk.state = LANE_STATE.DISABLED_BY_DEPENDENCY;
      talk.lastError = TALK_SEAM_UNAVAILABLE;
      logOnce(`TALK_${TALK_SEAM_UNAVAILABLE}`, `npcVoices: talk lane disabled_by_dependency - ${TALK_SEAM_UNAVAILABLE}`);
      return;
    }
    const seam = seams.seam;
    const S = T.settings;
    talk.seam = seam;
    const nameOf = (id) => {
      const r = seam.characterNameOf(id);
      return r && r.ok === true ? r.name : null;
    };
    talk.transcript = createTranscript({ maxLinesPerSystem: S.transcriptLines, maxSystems: S.maxSystems,
      maxAgeMs: S.contextMaxAgeMs, lineChars: S.lineChars, sharePlayerText: S.sharePlayerText, nameOf });
    const C = config.chatterAi || {};
    talk.lane = createTalkLane({ T: S, V, worldSeed: deps.worldSeed, now: () => clock.now(), metric, send: sendLocal,
      transcript: talk.transcript, nameOf, systemNameOf, glyphAlphabetOf: (voice) => alphabetOf(voice, V.glyphs.extended),
      chatter: { language: C.language, profanity: C.profanity }, getChatterAi: deps.getChatterAi,
      getPresence: deps.getPresence, getGraph: deps.getGraph });
    let tapped = null;
    try {
      tapped = seam.installTap(onTalkLine);
    } catch (err) {
      tapped = { ok: false, reason: "THREW", detail: codeOf(err) };
    }
    if (!tapped || tapped.ok !== true) {
      const why = tapped ? `${tapped.reason}${tapped.detail ? `:${tapped.detail}` : ""}` : "no_result";
      log(`npcVoices: talk tap refused - ${safeReason(why)}`);
      disableTalk(TALK_SEAM_UNAVAILABLE);
      return;
    }
    talk.tapped = true;
    talk.poller = createPoller({ runPass: talkPass, intervalMs: S.tickMs, now: () => clock.now(),
      setTimer: deps.setTimer, onError: (err) => disableTalk(`TIMER_FAILED:${codeOf(err)}`) });
    talk.state = LANE_STATE.RUNNING;
    if (local.lane && local.state === LANE_STATE.RUNNING) local.lane.setMuted(true);
    talk.poller.start();
  }

  function sampleReply(V, rec) {
    const S = siteSettingsOf(config);
    const colored = S.ok ? S.settings.colorSpeakers : false;
    const lines = [SAMPLE_HEADER];
    for (const voice of GLYPH_VOICES) {
      const text = glyphLine(createRng(deriveSeed(SAMPLE_SEED, "fv-sample-glyph", voice)),
        alphabetOf(voice, V.glyphs.extended), V.glyphs);
      if (text !== null) lines.push(formatSiteLine(SPEAKERS[voice][0], COLORS[voice], text, colored));
    }
    const pilot = rec && typeof rec.name === "string" && rec.name !== "" ? rec.name : SAMPLE_PILOT;
    const system = rec && Number.isSafeInteger(rec.systemId) ? systemNameOf(soft(deps.getGraph), rec.systemId) : null;
    for (const voice of SAMPLE_AI_VOICES) {
      const pick = pickVoiceLine({ voice, context: SAMPLE_CONTEXT, rng: createRng(deriveSeed(SAMPLE_SEED, "fv-sample",
        voice)), values: { system, pilot }, recentLineIds: [], ai: null, maxChars: V.maxLineChars, glyphs: null });
      if (pick.ok) lines.push(formatSiteLine(SPEAKERS[voice][0], COLORS[voice], pick.text, colored));
    }
    const extra = GLYPH_VOICES.map((voice) => EXTENDED_ALPHABETS[voice].filter((ch) => !ALPHABETS[voice].includes(ch))
      .slice(0, SAMPLE_EXTENDED_SIGNS).join("")).join(" ");
    lines.push(`Extended signs (npcVoices.glyphs.extended): ${extra}`);
    const fc = config.frontChat || {};
    const lineBreak = fc.lineBreak === "\\n" ? "\n" : String(fc.lineBreak ?? "\n");
    return lines.join(lineBreak);
  }

  function startCommand(V) {
    const adapter = deps.adapter;
    if (!adapter || typeof adapter.installChatCommand !== "function") {
      Object.assign(command, { state: "refused", reason: "adapter_unavailable" });
      return;
    }
    let installed = null;
    try {
      installed = adapter.installChatCommand({ name: COMMAND_NAME, match: (text) => COMMAND_RE.test(String(text)),
        handle: (rec) => (state === STATE.RUNNING ? sampleReply(V, rec) : FAIL_REPLY), failReply: FAIL_REPLY });
    } catch (err) {
      installed = { ok: false, reason: "THREW", detail: codeOf(err) };
    }
    if (installed && installed.ok === true) {
      command.state = "registered";
      return;
    }
    const why = installed ? `${installed.reason}${installed.detail ? `:${installed.detail}` : ""}` : "no_result";
    Object.assign(command, { state: "refused", reason: safeReason(why) });
    log(`npcVoices: !npcvoices refused - ${command.reason}`);
  }

  function stopCommand() {
    if (command.state !== "registered") return;
    command.state = "stopped";
    try {
      deps.adapter.uninstallChatCommand(COMMAND_NAME);
    } catch (err) {
      log(`npcVoices: !npcvoices uninstall failed - ${codeOf(err)}`);
    }
  }

  const settings = npcVoicesSettingsOf(config);
  if (!settings.ok) {
    state = STATE.DISABLED;
    lastError = safeReason(`INVALID_SETTINGS:${settings.detail}`);
    logOnce("INVALID", `npcVoices: disabled - ${lastError}`);
  } else if (clock === null) {
    state = STATE.DISABLED;
    lastError = "NO_CLOCK";
    logOnce("NO_CLOCK", "npcVoices: disabled - NO_CLOCK");
  } else {
    const V = settings.settings;
    const L = localSettingsOf(config);
    const P = config.localPilots;
    if (L.ok && L.settings.enabled !== true) {
      local.state = LANE_STATE.OFF;
    } else if (!L.ok) {
      disableLocal(`INVALID_SETTINGS:${L.detail}`);
    } else if (!P || P.enabled !== true) {
      local.state = LANE_STATE.DISABLED_BY_DEPENDENCY;
      local.lastError = "localPilots";
    } else if (!Number.isSafeInteger(deps.worldSeed)) {
      disableLocal("NO_WORLD_SEED");
    } else {
      local.lane = createLocalLane({ L: L.settings, V, worldSeed: deps.worldSeed, now: () => clock.now(), metric,
        send: sendLocal, getChatterAi: deps.getChatterAi, getPresence: deps.getPresence, getGraph: deps.getGraph,
        getFame: deps.getFame });
      local.poller = createPoller({ runPass: localPass, intervalMs: L.settings.tickMs, now: () => clock.now(),
        setTimer: deps.setTimer, onError: (err) => disableLocal(`TIMER_FAILED:${codeOf(err)}`) });
      local.state = LANE_STATE.RUNNING;
      local.poller.start();
    }
    startSite(V);
    startTalk(V);
    startCommand(V);
    log(`npcVoices: running local=${local.state} site=${site.state} talk=${talk.state} command=${command.state} `
      + `maxLineChars=${V.maxLineChars} glyphsExtended=${V.glyphs.extended}`);
  }

  function getStatus() {
    const out = { state, lanes: { local: { state: local.state,
      counters: local.lane ? local.lane.getStatus().counters : {},
      lastError: local.lastError } } };
    if (local.lane) {
      const st = local.lane.getStatus();
      out.lanes.local.systems = st.systems;
      if (st.lastSendError) out.lanes.local.lastSendError = st.lastSendError;
      if (talk.state === LANE_STATE.RUNNING && local.state === LANE_STATE.RUNNING) out.lanes.local.muted = true;
    }
    const laneStatus = talk.lane ? talk.lane.getStatus() : null;
    out.lanes.talk = { state: talk.state, systems: talk.transcript ? talk.transcript.systems() : 0,
      transcriptLines: talk.transcript ? talk.transcript.size() : 0, inFlight: laneStatus ? laneStatus.inFlight : 0,
      counters: { ...talk.counters, ...(laneStatus ? laneStatus.counters : {}) }, lastError: talk.lastError };
    if (laneStatus && laneStatus.lastSendError) out.lanes.talk.lastSendError = laneStatus.lastSendError;
    const siteStatus = site.lane ? site.lane.getStatus() : null;
    out.site = { state: site.state, pending: siteStatus ? siteStatus.pending : 0,
      counters: siteStatus ? siteStatus.counters : {}, lastError: site.lastError };
    if (siteStatus && siteStatus.lastSendError) out.site.lastSendError = siteStatus.lastSendError;
    out.command = { state: command.state, ...(command.reason ? { reason: command.reason } : {}) };
    if (lastError !== null) out.lastError = lastError;
    return out;
  }

  return Object.freeze({
    noteFactionCrews(bySystem, _atMs) {
      if (state !== STATE.RUNNING) return;
      noteTalkSystems(bySystem);
      try {
        if (local.state !== LANE_STATE.RUNNING) return;
        local.lane.noteFactionCrews(bySystem);
      } catch (err) {
        disableLocal(`NOTE_FAILED:${codeOf(err)}`);
      }
    },
    getStatus() {
      try {
        return getStatus();
      } catch (_err) {
        return { state, lastError: "STATUS_FAILED" };
      }
    },
    stop(reason) {
      if (state === STATE.STOPPED) return;
      state = STATE.STOPPED;
      if (local.poller) local.poller.stop();
      if (local.lane) local.lane.clear();
      if (local.state === LANE_STATE.RUNNING) local.state = LANE_STATE.STOPPED;
      if (site.poller) site.poller.stop();
      unhookSite();
      if (site.lane) site.lane.clear();
      if (site.state === LANE_STATE.RUNNING) site.state = LANE_STATE.STOPPED;
      quietTalk();
      untapTalk();
      if (talk.transcript) talk.transcript.clear();
      if (talk.state === LANE_STATE.RUNNING) talk.state = LANE_STATE.STOPPED;
      stopCommand();
      log(`npcVoices: stopped (${safeReason(reason || "stop")})`);
    },
  });
}

module.exports = { startNpcVoices, createOffNpcVoices, createUnavailableNpcVoices, COMMAND_NAME, COMMAND_RE };
