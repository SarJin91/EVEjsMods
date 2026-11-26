"use strict";

const { createPoller } = require("../presence/poller");
const { METRIC } = require("./schema");

const STEP = Object.freeze({ WAITING: "waiting", ROOM: "room", VOICE: "voice", DONE: "done" });
const STATE = Object.freeze({ IDLE: "idle", OFF: "off", RUNNING: "running", STOPPED: "stopped" });
const PRESENCE_UNKNOWN_NAME = "Unknown";
const MAX_CODE = 40;
const COUNTERS = Object.freeze(["invited", "noClient", "roomRefused", "voiceLinked", "voiceRefused", "expired",
  "passes", "presenceFailed", "stepFailed"]);
const METRIC_OF = Object.freeze({ invited: METRIC.autostartInvited, noClient: METRIC.autostartNoClient,
  roomRefused: METRIC.autostartRoomRefused, voiceLinked: METRIC.autostartVoiceLinked,
  voiceRefused: METRIC.autostartVoiceRefused, expired: METRIC.autostartExpired });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const codeOf = (value) => String(value ?? "unknown").replace(/[^\w:.\-]/g, "_").slice(0, MAX_CODE);

function createShipAiAutostart(deps) {
  const d = deps || {};
  const S = d.S || {};
  const nowMs = typeof d.nowMs === "function" ? d.nowMs : () => 0;
  const log = (line) => {
    if (typeof d.log !== "function") return;
    try {
      d.log(line);
    } catch (_err) {
    }
  };
  const telemetry = d.telemetry && typeof d.telemetry.count === "function" ? d.telemetry : null;
  const entries = new Map();
  const counters = Object.fromEntries(COUNTERS.map((n) => [n, 0]));
  const logged = new Set();
  let state = STATE.IDLE;

  const bump = (name) => {
    counters[name] += 1;
    if (!telemetry || !METRIC_OF[name]) return;
    try {
      telemetry.count(METRIC_OF[name], 1);
    } catch (_err) {
    }
  };
  const logOnce = (what, reason) => {
    const code = codeOf(reason);
    if (logged.has(`${what}:${code}`)) return;
    logged.add(`${what}:${code}`);
    log(`shipAi: autostart ${what} refused - ${code}`);
  };

  function roomStep(playerId, e, now) {
    const r = d.invite(playerId);
    if (r && r.ok) {
      bump("invited");
      e.step = STEP.VOICE;
      return;
    }
    const reason = r && r.reason ? r.reason : "INVITE_FAILED";
    if (reason === "NO_CLIENT") {
      if (now - e.seenAt <= S.autostartMaxWaitMs) {
        bump("noClient");
        return;
      }
      bump("expired");
    } else {
      bump("roomRefused");
      logOnce("invitation", reason);
    }
    e.step = STEP.VOICE;
  }

  function voiceStep(playerId, e, prefs) {
    e.step = STEP.DONE;
    if (!prefs.voice) return;
    const r = d.voiceLink(playerId, e.name);
    if (!r || !r.ok || !Array.isArray(r.lines) || r.lines.length === 0) {
      bump("voiceRefused");
      logOnce("voice link", r && r.reason ? r.reason : "VOICE_FAILED");
      return;
    }
    const sent = d.sendSystem(playerId, r.lines);
    if (sent && sent.system > 0) {
      bump("voiceLinked");
      return;
    }
    bump("voiceRefused");
    logOnce("voice link", "SEND_FAILED");
  }

  function step(playerId, e, now) {
    if (e.step === STEP.DONE) return;
    const prefs = d.prefsOf(playerId);
    if (!prefs || !d.isAllowed(playerId) || !d.isRunning()) {
      e.step = STEP.DONE;
      return;
    }
    if (e.step === STEP.WAITING) {
      if (now - e.seenAt < S.autostartLoginDelayMs) return;
      e.step = prefs.room ? STEP.ROOM : STEP.VOICE;
    }
    if (e.step === STEP.ROOM) {
      if (prefs.room) roomStep(playerId, e, now);
      else e.step = STEP.VOICE;
      if (e.step === STEP.ROOM) return;
    }
    if (e.step === STEP.VOICE) voiceStep(playerId, e, prefs);
  }

  function runPass() {
    counters.passes += 1;
    if (S.autostartEnabled !== true || !d.anyEnabled()) {
      entries.clear();
      return;
    }
    let res;
    try {
      res = d.readPresence();
    } catch (_err) {
      res = null;
    }
    if (!res || res.ok !== true || !Array.isArray(res.characters)) {
      counters.presenceFailed += 1;
      return;
    }
    const now = nowMs();
    const seen = new Set();
    for (const c of res.characters) {
      if (!c || !isId(c.characterId)) continue;
      const playerId = c.characterId;
      seen.add(playerId);
      let e = entries.get(playerId);
      try {
        if (!e) {
          if (!d.prefsOf(playerId) || !d.isAllowed(playerId) || !d.isRunning()) continue;
          e = { step: STEP.WAITING, seenAt: now,
            name: typeof c.name === "string" && c.name !== PRESENCE_UNKNOWN_NAME ? c.name : null };
          entries.set(playerId, e);
        }
        step(playerId, e, now);
      } catch (err) {
        counters.stepFailed += 1;
        if (e) e.step = STEP.DONE;
        logOnce("step", (err && (err.code || err.message)) || err);
      }
    }
    if (res.truncated === true) return;
    for (const playerId of [...entries.keys()]) {
      if (!seen.has(playerId)) entries.delete(playerId);
    }
  }

  const poller = createPoller({ runPass, intervalMs: S.autostartPollMs, now: nowMs, setTimer: d.setTimer,
    onError: (err) => logOnce("pass", (err && (err.code || err.message)) || err) });

  function start() {
    if (state !== STATE.IDLE) return;
    if (S.autostartEnabled !== true) {
      state = STATE.OFF;
      return;
    }
    poller.start();
    state = STATE.RUNNING;
  }

  function stop() {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    poller.stop();
    entries.clear();
  }

  function forget(playerId) {
    entries.delete(playerId);
  }

  function getStatus() {
    return { state, tracked: entries.size, counters: { ...counters } };
  }

  return Object.freeze({ start, stop, runPass, getStatus, forget });
}

module.exports = { createShipAiAutostart, AUTOSTART_STEP: STEP, AUTOSTART_STATE: STATE };
