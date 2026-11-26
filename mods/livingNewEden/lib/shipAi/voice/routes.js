"use strict";

const { originAllowed } = require("../../modSettings/web/routes");
const { METRIC, VOICE_INTEGER_RANGES } = require("../schema");
const { normalizeVoicePrefs, lengthScaleOf, piperVoiceLabel, PIPER_NAME_RE } = require("./voicePrefs");
const { voiceOf } = require("./piperEngine");

const PREFIX = "/api/shipai/";
const SID_HEADER = "x-lne-voice";
const JSON_TYPE = "application/json; charset=utf-8";
const AFTER_RE = /^[0-9]{1,15}$/;
const ROUTES = Object.freeze({ session: "POST", lines: "GET", logout: "POST", options: "GET", voice: "POST",
  test: "POST", persona: "POST" });
const PICKER_ROUTES = Object.freeze(["options", "voice", "test", "persona"]);
const TEST_TEXT = Object.freeze({ pl: "Test głosu pokładowej AI.", en: "Ship AI voice test." });
const PERSONA_ACTIONS = Object.freeze(["set", "custom", "reset"]);
const TEST_ENGINE_REASONS = Object.freeze(["BUDGET", "BREAKER", "DROPPED"]);
const HTTP_STATUS = Object.freeze({ BAD_BODY: 400, BAD_ENGINE: 400, BAD_PIPER_VOICE: 400, BAD_BROWSER_VOICE: 400,
  BAD_RATE: 400, BAD_PITCH: 400, BAD_RADIO: 400, PIPER_UNAVAILABLE: 503, NOT_PAIRED: 409, SAVE_FAILED: 500,
  PIPER_OFF: 409, UNAVAILABLE: 503, BUDGET: 503, BREAKER: 503, DROPPED: 503, TEST_TIMEOUT: 504, RATE_LIMITED: 429 });
const PANEL_ROUTES = Object.freeze({ panel: Object.freeze(["GET", "POST"]), "panel/action": Object.freeze(["POST"]) });
const PANEL_WING_SWITCH = "wingOpenAtLogin";
const PANEL_BOARD_SWITCH = "boardOpenAtLogin";
const BOARD_SWITCH_ID = "openAtLogin";
const PANEL_ACTIONS = Object.freeze(["inviteRoom", "openWing", "openBoard"]);
const PANEL_STATUS = Object.freeze({ BAD_BODY: 400, BAD_VALUE: 400, NO_PAIR: 409, UNAVAILABLE: 409,
  WING_UNAVAILABLE: 409, BOARD_UNAVAILABLE: 409, SAVE_FAILED: 500, RATE_LIMITED: 429 });
const PANEL_GAME_REFUSAL = 409;
const PANEL_CODE_MAX = 40;
const AUDIO = "audio/";
const AUDIO_TYPE = "audio/wav";
const AUDIO_ID_RE = /^[A-Za-z0-9_-]{22}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function headerOf(req, name) {
  const v = req && req.headers ? req.headers[name] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

function createVoiceRoutes(deps) {
  const sessions = deps.sessions;
  const queue = deps.queue;
  const telemetry = deps.telemetry && typeof deps.telemetry.count === "function" ? deps.telemetry : null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const counts = { opened: 0, refused: 0, audio: 0 };
  const pickerCounts = { optionsServed: 0, choicesSaved: 0, personaSaved: 0, tests: 0, testAudio: 0 };
  const pickerRefused = {};
  const picker = deps.picker && deps.picker.S && deps.picker.S.voicePickerEnabled === true ? deps.picker : null;
  const panel = deps.panel && deps.panel.S && deps.panel.S.panelEnabled === true
    && typeof deps.panel.nowMs === "function" && typeof deps.panel.stateOf === "function"
    && typeof deps.panel.applySwitch === "function" && typeof deps.panel.invite === "function" ? deps.panel : null;
  const panelCounts = { reads: 0, writes: 0, actions: 0, refused: 0 };
  const panelRefused = {};
  const lastPanelAt = new Map();
  const lastChoiceAt = new Map();
  const lastTestAt = new Map();
  const answered = new WeakSet();

  function metric(name) {
    if (!telemetry) return;
    try {
      telemetry.count(name, 1);
    } catch (_err) {
    }
  }

  function send(res, status, value, extra) {
    if (answered.has(res) || res.writableEnded === true || res.destroyed === true) return;
    answered.add(res);
    const body = JSON.stringify(value);
    res.writeHead(status, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body), ...(extra || {}) });
    res.end(body);
  }

  function fail(res, status, reason, extra) {
    if (status !== 404) counts.refused += 1;
    send(res, status, { ok: false, reason }, extra);
  }

  function bodyOf(body) {
    const text = body === null || body === undefined ? "" : String(body);
    try {
      const value = JSON.parse(text);
      return isPlainObject(value) ? { ok: true, value } : { ok: false };
    } catch (_err) {
      return { ok: false };
    }
  }

  function openSession(res, body) {
    const parsed = bodyOf(body);
    if (!parsed.ok) {
      fail(res, 400, "BAD_BODY");
      return;
    }
    const r = sessions.redeem(parsed.value.token);
    if (!r.ok || r.actor.characterId === null) {
      fail(res, 401, "BAD_TOKEN");
      return;
    }
    const playerId = r.actor.characterId;
    const previous = queue.listenerOf(playerId);
    const attached = queue.attach(playerId, r.sid);
    if (attached.superseded && typeof previous === "string") sessions.end(previous);
    counts.opened += 1;
    metric(METRIC.voiceSessions);
    log(`shipAi voice: listener attached (superseded=${attached.superseded})`);
    const info = deps.settingsOf(playerId);
    send(res, 200, { ok: true, sid: r.sid, aiName: info.aiName, lang: info.lang, settings: info.settings,
      choice: info.choice === undefined ? null : info.choice });
  }

  function lines(res, req, url) {
    const sid = headerOf(req, SID_HEADER);
    const session = typeof sid === "string" ? sessions.sessionOf(sid) : null;
    if (!session || session.actor.characterId === null) {
      if (typeof sid === "string" && queue.isRetired(sid)) fail(res, 409, "SUPERSEDED");
      else fail(res, 401, "NO_SESSION");
      return;
    }
    const after = url.searchParams.get("after");
    if (typeof after !== "string" || !AFTER_RE.test(after)) {
      fail(res, 400, "BAD_QUERY");
      return;
    }
    const playerId = session.actor.characterId;
    let r = queue.take(playerId, sid, Number(after));
    if (!r.ok && r.reason === "NO_LISTENER") {
      queue.attach(playerId, sid);
      r = queue.take(playerId, sid, Number(after));
    }
    if (!r.ok) {
      fail(res, 409, r.reason);
      return;
    }
    send(res, 200, { ok: true, epoch: r.epoch, next: r.next, lines: r.lines });
  }

  function logout(res, req) {
    const sid = headerOf(req, SID_HEADER);
    const session = typeof sid === "string" ? sessions.sessionOf(sid) : null;
    if (session) {
      if (session.actor.characterId !== null) queue.detach(session.actor.characterId, sid);
      sessions.end(sid);
    }
    send(res, 200, { ok: true });
  }

  function audio(res, req, id) {
    const sid = headerOf(req, SID_HEADER);
    const session = typeof sid === "string" ? sessions.sessionOf(sid) : null;
    if (!session || session.actor.characterId === null) {
      fail(res, 401, "NO_SESSION");
      return;
    }
    let bytes = null;
    try {
      bytes = AUDIO_ID_RE.test(id) && typeof deps.audioOf === "function"
        ? deps.audioOf(id, session.actor.characterId) : null;
    } catch (_err) {
      bytes = null;
    }
    if (!Buffer.isBuffer(bytes)) {
      fail(res, 404, "NOT_FOUND");
      return;
    }
    counts.audio += 1;
    res.writeHead(200, { "Content-Type": AUDIO_TYPE, "Cache-Control": "no-store", "Content-Length": bytes.length });
    res.end(bytes);
  }

  function pickerFail(res, reason, extra) {
    pickerRefused[reason] = (pickerRefused[reason] || 0) + 1;
    const status = Object.prototype.hasOwnProperty.call(HTTP_STATUS, reason) ? HTTP_STATUS[reason] : 400;
    send(res, status, { ok: false, reason, ...(extra || {}) });
  }

  function sessionPlayer(req, res) {
    const sid = headerOf(req, SID_HEADER);
    const session = typeof sid === "string" ? sessions.sessionOf(sid) : null;
    if (!session || session.actor.characterId === null) {
      if (typeof sid === "string" && queue.isRetired(sid)) fail(res, 409, "SUPERSEDED");
      else fail(res, 401, "NO_SESSION");
      return null;
    }
    return session.actor.characterId;
  }

  function cooldown(map, playerId, ms, nowMs = picker.nowMs) {
    const now = nowMs();
    const last = map.get(playerId);
    if (last !== undefined && now - last < ms) return ms - (now - last);
    for (const [id, at] of map) {
      if (now - at >= ms) map.delete(id);
    }
    map.set(playerId, now);
    return null;
  }

  const rangesOf = () => ({ rateMilli: VOICE_INTEGER_RANGES.voiceRateMilli,
    pitchMilli: VOICE_INTEGER_RANGES.voicePitchMilli });

  async function piperVoicesNow() {
    const engine = picker.engine;
    if (!engine) return null;
    const known = engine.knownVoices(picker.lang);
    if (known) return known;
    const listed = await engine.listVoices(picker.lang);
    return listed && listed.ok ? new Set(listed.voices) : null;
  }

  async function options(res, playerId) {
    const S = picker.S;
    const engine = picker.engine;
    const defaultVoice = engine ? voiceOf(S, picker.lang) : null;
    let piper = { status: "OFF", voices: [], defaultVoice };
    if (engine) {
      const listed = await engine.listVoices(picker.lang);
      piper = listed && listed.ok
        ? { status: "ok", voices: listed.voices.map((id) => ({ id, label: piperVoiceLabel(id) })), defaultVoice }
        : { status: "UNAVAILABLE", voices: [], defaultVoice };
    }
    pickerCounts.optionsServed += 1;
    send(res, 200, { ok: true, engine: engine ? "piper" : "browser", piper,
      defaults: { rateMilli: S.voiceRateMilli, pitchMilli: S.voicePitchMilli, radio: S.voiceRadioFilter,
        voiceName: S.voiceName },
      ranges: rangesOf(), choice: picker.voicePrefs.get(playerId), persona: picker.persona.view(playerId) });
  }

  async function saveVoice(res, playerId, body) {
    const waitMs = cooldown(lastChoiceAt, playerId, picker.S.voiceChoiceCooldownMs);
    if (waitMs !== null) {
      pickerFail(res, "RATE_LIMITED", { waitMs });
      return;
    }
    const parsed = bodyOf(body);
    if (!parsed.ok) {
      pickerFail(res, "BAD_BODY");
      return;
    }
    const wantsPiper = parsed.value.piper !== undefined && parsed.value.piper !== null;
    const piperVoices = wantsPiper ? await piperVoicesNow() : null;
    const ranges = rangesOf();
    const normalized = normalizeVoicePrefs(parsed.value, { piperVoices, rateRange: ranges.rateMilli,
      pitchRange: ranges.pitchMilli });
    if (!normalized.ok) {
      pickerFail(res, normalized.reason);
      return;
    }
    const saved = picker.voicePrefs.save(playerId, normalized.prefs);
    if (!saved || saved.ok !== true) {
      pickerFail(res, saved && saved.reason === "NOT_PAIRED" ? "NOT_PAIRED" : "SAVE_FAILED");
      return;
    }
    pickerCounts.choicesSaved += 1;
    send(res, 200, { ok: true, choice: saved.prefs });
  }

  async function savePersona(res, playerId, body) {
    const waitMs = cooldown(lastChoiceAt, playerId, picker.S.voiceChoiceCooldownMs);
    if (waitMs !== null) {
      pickerFail(res, "RATE_LIMITED", { waitMs });
      return;
    }
    const parsed = bodyOf(body);
    const v = parsed.ok ? parsed.value : null;
    if (!v || !PERSONA_ACTIONS.includes(v.action) || (v.action === "set" && typeof v.preset !== "string")
      || (v.action === "custom" && v.text !== undefined && v.text !== null && typeof v.text !== "string")) {
      pickerFail(res, "BAD_BODY");
      return;
    }
    const req = v.action === "set" ? { action: "set", preset: v.preset }
      : v.action === "custom" ? { action: "custom", text: typeof v.text === "string" ? v.text : "" }
        : { action: "reset" };
    const r = picker.persona.apply(playerId, req);
    if (!r || r.ok !== true) {
      pickerFail(res, r && typeof r.reason === "string" ? r.reason : "SAVE_FAILED");
      return;
    }
    pickerCounts.personaSaved += 1;
    send(res, 200, { ok: true, persona: picker.persona.view(playerId) });
  }

  async function voiceTest(res, playerId, body) {
    const S = picker.S;
    const engine = picker.engine;
    if (!engine) {
      pickerFail(res, "PIPER_OFF");
      return;
    }
    const waitMs = cooldown(lastTestAt, playerId, S.voiceTestCooldownMs);
    if (waitMs !== null) {
      pickerFail(res, "RATE_LIMITED", { waitMs });
      return;
    }
    const parsed = bodyOf(body === null || body === undefined || String(body) === "" ? "{}" : body);
    if (!parsed.ok) {
      pickerFail(res, "BAD_BODY");
      return;
    }
    const choice = picker.voicePrefs.get(playerId);
    const asked = parsed.value;
    const rate = asked.rateMilli === undefined || asked.rateMilli === null
      ? (choice ? choice.rateMilli : null) : asked.rateMilli;
    const range = VOICE_INTEGER_RANGES.voiceRateMilli;
    if (rate !== null && (!Number.isSafeInteger(rate) || rate < range[0] || rate > range[1])) {
      pickerFail(res, "BAD_RATE");
      return;
    }
    let voice = asked.voice === undefined || asked.voice === null ? (choice ? choice.piper : null) : asked.voice;
    if (voice !== null) {
      if (typeof voice !== "string" || !PIPER_NAME_RE.test(voice)) {
        pickerFail(res, "BAD_PIPER_VOICE");
        return;
      }
      const known = await piperVoicesNow();
      if (!known) {
        pickerFail(res, "UNAVAILABLE");
        return;
      }
      if (!known.has(voice)) {
        if (asked.voice !== undefined && asked.voice !== null) {
          pickerFail(res, "BAD_PIPER_VOICE");
          return;
        }
        voice = null;
      }
    }
    pickerCounts.tests += 1;
    const text = TEST_TEXT[String(picker.lang).slice(0, 2).toLowerCase()] || TEST_TEXT.en;
    const signal = (typeof picker.timeoutSignal === "function" ? picker.timeoutSignal
      : (ms) => AbortSignal.timeout(ms))(S.voiceTestTimeoutMs);
    const timedOut = new Promise((resolve) => {
      if (signal.aborted) resolve({ timeout: true });
      else signal.addEventListener("abort", () => resolve({ timeout: true }), { once: true });
    });
    const synth = engine.synthesize(playerId, text, picker.lang, { voice: voice === null ? undefined : voice,
      lengthScaleMilli: lengthScaleOf(S.voiceLengthScaleMilli, rate) });
    const r = await Promise.race([synth, timedOut]);
    if (r && r.timeout === true) {
      pickerFail(res, "TEST_TIMEOUT");
      return;
    }
    if (!r || r.ok !== true) {
      pickerFail(res, r && TEST_ENGINE_REASONS.includes(r.reason) ? r.reason : "UNAVAILABLE");
      return;
    }
    pickerCounts.testAudio += 1;
    send(res, 200, { ok: true, audioId: r.audioId });
  }

  function runPicker(name, req, res, body) {
    const playerId = sessionPlayer(req, res);
    if (playerId === null) return;
    let p;
    try {
      if (name === "options") p = options(res, playerId);
      else if (name === "voice") p = saveVoice(res, playerId, body);
      else if (name === "test") p = voiceTest(res, playerId, body);
      else p = savePersona(res, playerId, body);
    } catch (_err) {
      p = null;
    }
    const failed = () => {
      log("shipAi voice: picker route failed");
      send(res, 500, { ok: false, reason: "HANDLER_FAILED" });
    };
    if (!p || typeof p.then !== "function") failed();
    else p.then(undefined, failed);
  }

  const panelCode = (value) => String(value ?? "UNKNOWN").replace(/[^\w:.\-]/g, "_").slice(0, PANEL_CODE_MAX);
  const onOffOf = (value) => {
    if (value === true || value === "on") return "on";
    if (value === false || value === "off") return "off";
    return null;
  };

  function panelFail(res, reason, extra) {
    panelCounts.refused += 1;
    panelRefused[reason] = (panelRefused[reason] || 0) + 1;
    metric(METRIC.panelRefused);
    const status = Object.prototype.hasOwnProperty.call(PANEL_STATUS, reason) ? PANEL_STATUS[reason]
      : PANEL_GAME_REFUSAL;
    send(res, status, { ok: false, reason, ...(extra || {}) });
  }

  function wingView(playerId) {
    const wing = panel.wing;
    if (!wing || typeof wing.available !== "function" || wing.available() !== true) return { available: false };
    const r = wing.get(playerId);
    if (r && r.ok === true) return { available: true, openAtLogin: r.openAtLogin === true };
    if (r && r.available === false) return { available: false };
    return { available: true, openAtLogin: null, reason: panelCode(r && r.reason) };
  }

  const wingUp = () => Boolean(panel.wing) && typeof panel.wing.available === "function"
    && panel.wing.available() === true;

  function boardUp() {
    const b = typeof panel.board === "function" ? panel.board() : null;
    if (!b || typeof b.applySwitch !== "function" || typeof b.prefsOf !== "function" || typeof b.open !== "function"
      || typeof b.getStatus !== "function") {
      return null;
    }
    const st = b.getStatus();
    return st && st.state === "running" ? b : null;
  }

  function boardView(playerId) {
    const b = boardUp();
    if (!b) return { available: false };
    const r = b.prefsOf(playerId);
    if (r && r.ok === true) return { available: true, openAtLogin: r.openAtLogin === true, serverOn: r.serverOn === true };
    return { available: true, openAtLogin: null, reason: panelCode(r && r.reason) };
  }

  const panelView = (playerId) => ({ ...panel.stateOf(playerId), wing: wingView(playerId),
    board: boardView(playerId) });

  function panelSwitch(res, playerId, body) {
    const parsed = bodyOf(body);
    if (!parsed.ok || typeof parsed.value.id !== "string") {
      panelFail(res, "BAD_BODY");
      return;
    }
    const { id, value } = parsed.value;
    let saved;
    if (id === PANEL_WING_SWITCH) {
      const on = onOffOf(value);
      if (on === null) {
        panelFail(res, "BAD_VALUE");
        return;
      }
      if (!wingUp()) {
        panelFail(res, "WING_UNAVAILABLE");
        return;
      }
      const r = panel.wing.set(playerId, on === "on");
      if (!r || r.ok !== true) {
        panelFail(res, r && r.available === false ? "WING_UNAVAILABLE" : panelCode(r && r.reason));
        return;
      }
      saved = r.openAtLogin === true ? "on" : "off";
    } else if (id === PANEL_BOARD_SWITCH) {
      const on = onOffOf(value);
      if (on === null) {
        panelFail(res, "BAD_VALUE");
        return;
      }
      const board = boardUp();
      if (!board) {
        panelFail(res, "BOARD_UNAVAILABLE");
        return;
      }
      const r = board.applySwitch(playerId, BOARD_SWITCH_ID, on);
      if (!r || r.ok !== true) {
        panelFail(res, panelCode(r && r.reason));
        return;
      }
      saved = r.value;
    } else {
      const r = panel.applySwitch(playerId, id, value);
      if (!r || r.ok !== true) {
        panelFail(res, r && typeof r.reason === "string" ? panelCode(r.reason) : "SAVE_FAILED");
        return;
      }
      saved = r.value;
    }
    panelCounts.writes += 1;
    metric(METRIC.panelWrites);
    send(res, 200, { ok: true, id, value: saved, panel: panelView(playerId) });
  }

  function panelAction(res, playerId, body) {
    const parsed = bodyOf(body);
    if (!parsed.ok) {
      panelFail(res, "BAD_BODY");
      return;
    }
    const id = parsed.value.id;
    if (!PANEL_ACTIONS.includes(id)) {
      panelFail(res, "BAD_VALUE");
      return;
    }
    if (id === "openWing" && !wingUp()) {
      panelFail(res, "WING_UNAVAILABLE");
      return;
    }
    const board = id === "openBoard" ? boardUp() : null;
    if (id === "openBoard" && !board) {
      panelFail(res, "BOARD_UNAVAILABLE");
      return;
    }
    panelCounts.actions += 1;
    metric(METRIC.panelActions);
    let r;
    if (id === "inviteRoom") r = panel.invite(playerId);
    else if (id === "openBoard") r = board.open(playerId);
    else r = panel.wing.open(playerId);
    if (!r || r.ok !== true) {
      panelFail(res, r && r.available === false ? "WING_UNAVAILABLE" : panelCode(r && r.reason), { id });
      return;
    }
    send(res, 200, { ok: true, id, code: "OK" });
  }

  function runPanel(name, req, res, body) {
    const playerId = sessionPlayer(req, res);
    if (playerId === null) return;
    try {
      if (req.method === "GET") {
        const view = panelView(playerId);
        panelCounts.reads += 1;
        metric(METRIC.panelReads);
        send(res, 200, { ok: true, panel: view });
        return;
      }
      const waitMs = cooldown(lastPanelAt, playerId, panel.S.panelCooldownMs, panel.nowMs);
      if (waitMs !== null) {
        panelFail(res, "RATE_LIMITED", { waitMs });
        return;
      }
      if (name === "panel") panelSwitch(res, playerId, body);
      else panelAction(res, playerId, body);
    } catch (_err) {
      log("shipAi voice: panel route failed");
      send(res, 500, { ok: false, reason: "HANDLER_FAILED" });
    }
  }

  function handle(req, res, body) {
    let url;
    try {
      url = new URL(String(req.url), "http://localhost");
    } catch (_err) {
      fail(res, 400, "BAD_REQUEST");
      return;
    }
    const name = url.pathname.slice(PREFIX.length);
    if (name.startsWith(AUDIO)) {
      if (req.method !== "GET") fail(res, 405, "METHOD_NOT_ALLOWED", { Allow: "GET" });
      else audio(res, req, name.slice(AUDIO.length));
      return;
    }
    const origin = headerOf(req, "origin");
    if (Object.prototype.hasOwnProperty.call(PANEL_ROUTES, name)) {
      const allowed = PANEL_ROUTES[name];
      if (!panel) fail(res, 404, "NOT_FOUND");
      else if (!allowed.includes(req.method)) fail(res, 405, "METHOD_NOT_ALLOWED", { Allow: allowed.join(", ") });
      else if (req.method === "POST" && origin !== undefined && !originAllowed(origin)) {
        fail(res, 403, "ORIGIN_NOT_ALLOWED");
      } else runPanel(name, req, res, body);
      return;
    }
    const method = Object.prototype.hasOwnProperty.call(ROUTES, name) ? ROUTES[name] : null;
    if (method === null || (PICKER_ROUTES.includes(name) && !picker)) {
      fail(res, 404, "NOT_FOUND");
      return;
    }
    if (req.method !== method) {
      fail(res, 405, "METHOD_NOT_ALLOWED", { Allow: method });
      return;
    }
    if (method === "POST" && origin !== undefined && !originAllowed(origin)) {
      fail(res, 403, "ORIGIN_NOT_ALLOWED");
      return;
    }
    if (name === "session") openSession(res, body);
    else if (name === "lines") lines(res, req, url);
    else if (name === "logout") logout(res, req);
    else runPicker(name, req, res, body);
  }

  function status() {
    const out = { ...counts };
    if (picker) {
      Object.assign(out, pickerCounts);
      for (const [reason, n] of Object.entries(pickerRefused)) out[`refused_${reason}`] = n;
    }
    if (panel) {
      out.panel = { ...panelCounts };
      for (const [reason, n] of Object.entries(panelRefused)) out.panel[`refused_${reason}`] = n;
    }
    return out;
  }

  return Object.freeze({ prefix: PREFIX, handle, status });
}

module.exports = { PREFIX, SID_HEADER, TEST_TEXT, createVoiceRoutes };
