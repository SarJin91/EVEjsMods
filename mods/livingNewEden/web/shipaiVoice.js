"use strict";

(function shipAiVoiceModule(global) {
  const API = "/api/shipai/";
  const SID_KEY = "lne-shipai-voice-sid";
  const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
  const SUBTITLES_MAX = 20;
  const TEST_TEXT = Object.freeze({ pl: "Test głosu pokładowej AI.", en: "Ship AI voice test." });
  const MILLI = 1000;
  const RADIO = Object.freeze({ highpassHz: 280, lowpassHz: 3800, drive: 2.2, gain: 0.85, curveSamples: 1024 });
  const AUDIO_ID_RE = /^[A-Za-z0-9_-]{22}$/;

  function tokenOf(hash) {
    const text = String(hash || "").replace(/^#/, "");
    for (const part of text.split("&")) {
      const eq = part.indexOf("=");
      if (eq !== -1 && part.slice(0, eq) === "t" && TOKEN_RE.test(part.slice(eq + 1))) return part.slice(eq + 1);
    }
    return null;
  }

  function pickVoice(voices, lang, voiceName, allowRemote) {
    const prefix = String(lang || "").slice(0, 2).toLowerCase();
    const list = Array.from(voices || []).filter((v) => v && String(v.lang || "").toLowerCase().startsWith(prefix)
      && (allowRemote === true || v.localService === true));
    if (list.length === 0) return null;
    const wanted = String(voiceName || "").toLowerCase();
    if (wanted !== "") {
      const named = list.find((v) => String(v.name || "").toLowerCase().includes(wanted));
      if (named) return named;
    }
    const exact = list.find((v) => String(v.lang || "").toLowerCase() === String(lang || "").toLowerCase());
    return exact || list[0];
  }

  function freshLines(lines, after) {
    return (Array.isArray(lines) ? lines : []).filter((l) => l && Number.isSafeInteger(l.seq) && l.seq > after
      && Array.isArray(l.parts)).sort((a, b) => a.seq - b.seq);
  }

  function softCurve(drive, samples) {
    const curve = new Float32Array(samples);
    const norm = Math.tanh(drive);
    for (let i = 0; i < samples; i += 1) {
      const x = (i * 2) / (samples - 1) - 1;
      curve[i] = Math.tanh(drive * x) / norm;
    }
    return curve;
  }

  const PIPER_PREFIX = "piper:";
  const BROWSER_PREFIX = "browser:";

  function voiceOptions(piperVoices, browserVoices, lang, allowRemote) {
    const groups = [{ label: null, options: [{ value: "", label: "Server default" }] }];
    const piper = (Array.isArray(piperVoices) ? piperVoices : []).filter((v) => v && typeof v.id === "string")
      .map((v) => ({ value: `${PIPER_PREFIX}${v.id}`, label: String(v.label || v.id) }));
    if (piper.length > 0) groups.push({ label: "Piper (server)", options: piper });
    const prefix = String(lang || "").slice(0, 2).toLowerCase();
    const seen = new Set();
    const browser = [];
    for (const v of Array.from(browserVoices || [])) {
      if (!v || typeof v.name !== "string" || v.name === "" || seen.has(v.name)) continue;
      if (!String(v.lang || "").toLowerCase().startsWith(prefix)) continue;
      if (allowRemote !== true && v.localService !== true) continue;
      seen.add(v.name);
      browser.push({ value: `${BROWSER_PREFIX}${v.name}`, label: `${v.name} (${v.lang})` });
    }
    if (browser.length > 0) groups.push({ label: "This browser", options: browser });
    return groups;
  }

  function parseVoiceValue(value) {
    const text = String(value || "");
    if (text.startsWith(PIPER_PREFIX) && text.length > PIPER_PREFIX.length) {
      return { engine: "piper", id: text.slice(PIPER_PREFIX.length) };
    }
    if (text.startsWith(BROWSER_PREFIX) && text.length > BROWSER_PREFIX.length) {
      return { engine: "browser", id: text.slice(BROWSER_PREFIX.length) };
    }
    return null;
  }

  function choiceFromForm(form) {
    const f = form || {};
    const v = parseVoiceValue(f.value);
    const browser = v ? v.engine === "browser" : f.serverEngine !== "piper";
    const milli = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x) * MILLI) : null);
    return { engine: v ? v.engine : null, piper: v && v.engine === "piper" ? v.id : null,
      browser: v && v.engine === "browser" ? v.id : null, rateMilli: milli(f.rate),
      pitchMilli: browser ? milli(f.pitch) : null, radio: browser ? null : f.radio === true };
  }

  function effectiveVoice(settings, choice) {
    const s = settings || {};
    const c = choice || {};
    const pick = (a, b) => (a === null || a === undefined ? b : a);
    return { piperOn: s.engine === "piper" && c.engine !== "browser", rateMilli: pick(c.rateMilli, s.rateMilli),
      pitchMilli: pick(c.pitchMilli, s.pitchMilli), radio: pick(c.radio, s.radioFilter),
      voiceName: pick(c.browser, s.voiceName) };
  }

  function panelPressed(view) {
    const v = view || {};
    const on = (x) => x === "on";
    return { autoRoom: on(v.autoRoom), autoVoice: on(v.autoVoice), alerts: on(v.alerts), scan: on(v.scan),
      quiet: on(v.quiet), wingOpenAtLogin: Boolean(v.wing && v.wing.openAtLogin === true),
      boardOpenAtLogin: Boolean(v.board && v.board.openAtLogin === true),
      mail: typeof v.mail === "string" ? v.mail : null };
  }

  const pure = { tokenOf, pickVoice, freshLines, softCurve, voiceOptions, parseVoiceValue, choiceFromForm,
    effectiveVoice, panelPressed };
  global.LneShipAiVoice = { _pure: pure };

  const doc = global.document;
  const synth = global.speechSynthesis;
  const AudioCtx = global.AudioContext || global.webkitAudioContext || null;
  if (!doc || typeof global.fetch !== "function") return;

  const el = (id) => doc.getElementById(id);
  const state = { sid: null, settings: null, lang: "en-US", aiName: "", running: false, muted: false, epoch: null,
    after: 0, timer: null, queue: [], current: null, voice: null, audio: null, source: null, choice: null,
    options: null, panel: null };

  const eff = () => effectiveVoice(state.settings, state.choice);
  const piperOn = () => Boolean(state.settings) && eff().piperOn;
  const fallbackOn = () => !piperOn() || state.settings.fallbackBrowser !== false;

  function show(text) {
    el("msg").textContent = String(text);
  }

  function enable(ids, on) {
    for (const id of ids) el(id).disabled = !on;
  }

  function storeSid(sid) {
    try {
      if (sid) global.sessionStorage.setItem(SID_KEY, sid);
      else global.sessionStorage.removeItem(SID_KEY);
    } catch (_err) {
    }
  }

  function readSid() {
    try {
      return global.sessionStorage.getItem(SID_KEY);
    } catch (_err) {
      return null;
    }
  }

  function chooseVoice() {
    if (!synth || !state.settings) return;
    state.voice = pickVoice(synth.getVoices(), state.lang, eff().voiceName, state.settings.allowRemote);
    if (state.options) fillVoiceSelect();
    const browser = state.voice ? `${state.voice.name} (${state.voice.lang})`
      : `no ${state.settings.allowRemote ? "" : "local "}voice for ${state.lang}`;
    if (!piperOn()) el("voice").textContent = state.voice ? `voice: ${browser}` : browser;
    else el("voice").textContent = `voice: Piper; browser fallback: ${fallbackOn() ? browser : "off"}`;
  }

  function noVoiceHint() {
    show(`No ${state.settings && state.settings.allowRemote ? "" : "local "}voice for ${state.lang} in this browser. `
      + "Windows: Settings - Time and language - Speech - add a voice, then reload this page. The lines stay silent.");
  }

  function addSubtitle(line) {
    if (!state.settings || state.settings.showText !== true) return;
    const box = el("lines");
    const row = doc.createElement("div");
    row.className = "row";
    row.textContent = `${state.aiName}: ${line.parts.join(" ")}`;
    box.appendChild(row);
    while (box.childNodes.length > SUBTITLES_MAX) box.removeChild(box.firstChild);
  }

  function utterance(text, over) {
    const u = new global.SpeechSynthesisUtterance(String(text));
    const e = eff();
    const o = over || {};
    u.lang = state.lang;
    const voice = o.voice !== undefined ? o.voice : state.voice;
    if (voice) u.voice = voice;
    u.rate = (o.rateMilli || e.rateMilli) / MILLI;
    u.pitch = (o.pitchMilli || e.pitchMilli) / MILLI;
    return u;
  }

  function radioInput(ctx) {
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = RADIO.highpassHz;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = RADIO.lowpassHz;
    const shaper = ctx.createWaveShaper();
    shaper.curve = softCurve(RADIO.drive, RADIO.curveSamples);
    shaper.oversample = "2x";
    const gain = ctx.createGain();
    gain.gain.value = RADIO.gain;
    hp.connect(lp);
    lp.connect(shaper);
    shaper.connect(gain);
    gain.connect(ctx.destination);
    return hp;
  }

  function stopSource() {
    const src = state.source;
    state.source = null;
    if (!src) return;
    try {
      src.stop();
    } catch (_err) {
    }
  }

  function finishLine(cur) {
    if (state.current !== cur) return;
    cur.speaking = false;
    cur.audioId = null;
    cur.index = cur.parts.length;
    speakNext();
  }

  async function playAudio(cur) {
    cur.speaking = true;
    let buffer = null;
    try {
      const res = await global.fetch(`${API}audio/${cur.audioId}`, { headers: { "X-LNE-Voice": state.sid },
        cache: "no-store", credentials: "omit" });
      if (res.ok) buffer = await state.audio.decodeAudioData(await res.arrayBuffer());
    } catch (_err) {
      buffer = null;
    }
    if (state.current !== cur) return;
    if (!buffer || !state.running || state.muted) {
      cur.speaking = false;
      cur.audioId = null;
      if (!buffer && fallbackOn()) speakNext();
      else finishLine(cur);
      return;
    }
    const src = state.audio.createBufferSource();
    src.buffer = buffer;
    src.connect(eff().radio === false ? state.audio.destination : radioInput(state.audio));
    src.onended = () => {
      if (state.source === src) state.source = null;
      finishLine(cur);
    };
    state.source = src;
    src.start();
  }

  function speakNext() {
    if (!state.running || state.muted) return;
    if (state.current && state.current.index < state.current.parts.length) {
      if (state.current.speaking) return;
      const cur = state.current;
      if (cur.audioId) {
        if (state.audio) {
          playAudio(cur);
          return;
        }
        cur.audioId = null;
        if (!fallbackOn()) {
          finishLine(cur);
          return;
        }
      }
      if (!synth || !state.voice) {
        if (piperOn()) {
          noVoiceHint();
          finishLine(cur);
          return;
        }
        state.current = null;
        state.queue.length = 0;
        noVoiceHint();
        return;
      }
      const u = utterance(cur.parts[cur.index]);
      const done = () => {
        if (state.current !== cur) return;
        cur.speaking = false;
        cur.index += 1;
        speakNext();
      };
      u.onend = done;
      u.onerror = done;
      cur.speaking = true;
      synth.speak(u);
      return;
    }
    const next = state.queue.shift();
    state.current = next ? { parts: next.parts.slice(), index: 0, speaking: false,
      audioId: piperOn() && typeof next.audioId === "string" && AUDIO_ID_RE.test(next.audioId) ? next.audioId : null }
      : null;
    if (state.current) speakNext();
  }

  function enqueue(line) {
    addSubtitle(line);
    if (state.muted) return;
    if (piperOn() && !line.audioId && !fallbackOn()) return;
    state.queue.push(line);
    while (state.queue.length > state.settings.queueMax) state.queue.shift();
    speakNext();
  }

  function schedule(ms) {
    if (state.timer !== null) global.clearTimeout(state.timer);
    state.timer = state.running ? global.setTimeout(poll, ms) : null;
  }

  function halt(text) {
    state.running = false;
    schedule(0);
    stopSource();
    if (synth) synth.cancel();
    state.queue.length = 0;
    state.current = null;
    enable(["stop", "skip", "mute"], false);
    if (text) show(text);
  }

  function endSession(text) {
    halt(text);
    state.sid = null;
    storeSid(null);
    enable(["start", "test"], false);
  }

  async function poll() {
    state.timer = null;
    if (!state.running || !state.sid) return;
    let res;
    let body = null;
    try {
      res = await global.fetch(`${API}lines?after=${state.after}`, { headers: { "X-LNE-Voice": state.sid },
        cache: "no-store", credentials: "omit" });
      body = await res.json();
    } catch (_err) {
      schedule(state.settings.pollMs);
      return;
    }
    if (res.status === 401) {
      endSession("The voice session expired. Type !ai voice in the game for a new link.");
      return;
    }
    if (res.status === 409) {
      endSession("Another tab took over the voice of your ship AI. This page stops.");
      return;
    }
    if (!res.ok || !body || body.ok !== true) {
      schedule(state.settings.pollMs);
      return;
    }
    if (state.epoch !== null && body.epoch !== state.epoch) {
      state.epoch = body.epoch;
      state.after = 0;
      schedule(0);
      return;
    }
    state.epoch = body.epoch;
    for (const line of freshLines(body.lines, state.after)) {
      state.after = line.seq;
      enqueue(line);
    }
    if (Number.isSafeInteger(body.next) && body.next > state.after) state.after = body.next;
    schedule(state.settings.pollMs);
  }

  function ready(info) {
    state.settings = info.settings;
    state.lang = info.lang || "en-US";
    state.aiName = String(info.aiName || "Ship AI");
    state.choice = info.choice && typeof info.choice === "object" ? info.choice : null;
    el("who").textContent = state.aiName;
    chooseVoice();
    enable(["start", "test"], true);
    show(synth || (piperOn() && AudioCtx) ? "Press Start to hear your ship AI."
      : "This browser has no speech synthesis.");
    loadOptions();
    loadPanel();
  }

  const REASON_TEXT = Object.freeze({
    en: { LENGTH: "Too short or too long (3-{max} characters).", RULES: "This style breaks the rules of the AI.",
      LINK: "No links in a persona.", CHARSET: "Characters outside the language of the server.",
      BANNED: "Banned words.", SEXUAL: "No sexual styles.", META: "No talk about the prompt or the model.",
      INJECTION: "That looks like an instruction, not a style.", NO_CUSTOM: "Write your own style first.",
      UNKNOWN_PRESET: "No such persona.", RATE_LIMITED: "Too fast, wait a moment.",
      NOT_PAIRED: "Type !ai in the game first.", SAVE_FAILED: "The server did not save it.",
      BAD_PIPER_VOICE: "This Piper voice is not on the server.", PIPER_UNAVAILABLE: "Piper does not answer now.",
      TEST_TIMEOUT: "The voice is loading on the server. Press Test again in a moment.",
      UNAVAILABLE: "Piper did not answer.", BUDGET: "The daily voice budget is used up.",
      BREAKER: "Piper failed a few times, it rests for a minute.", DROPPED: "Piper is busy, try again.",
      NO_PAIR: "Type !ai in the game first.", WING_UNAVAILABLE: "The wing window is not on this server.",
      BOARD_UNAVAILABLE: "The board window is not on this server.",
      UNAVAILABLE_MAIL: "The mail reader is off on this server.", CLIENT_NOT_READY: "The game client is not ready.",
      NO_CLIENT: "No chat client of yours is connected." },
    pl: { LENGTH: "Za krótki lub za długi (3-{max} znaków).", RULES: "Ten styl łamie zasady AI.",
      LINK: "Bez linków w personie.", CHARSET: "Znaki spoza języka serwera.", BANNED: "Zakazane słowa.",
      SEXUAL: "Bez stylów erotycznych.", META: "Bez rozmów o prompcie i modelu.",
      INJECTION: "To wygląda na polecenie, nie na styl.", NO_CUSTOM: "Najpierw wpisz własny styl.",
      UNKNOWN_PRESET: "Nie ma takiej persony.", RATE_LIMITED: "Za szybko, chwilę poczekaj.",
      NOT_PAIRED: "Najpierw wpisz !ai w grze.", SAVE_FAILED: "Serwer tego nie zapisał.",
      BAD_PIPER_VOICE: "Tego głosu Pipera nie ma na serwerze.", PIPER_UNAVAILABLE: "Piper teraz nie odpowiada.",
      TEST_TIMEOUT: "Głos ładuje się na serwerze. Za chwilę naciśnij Test jeszcze raz.",
      UNAVAILABLE: "Piper nie odpowiedział.", BUDGET: "Dzienny budżet głosu się skończył.",
      BREAKER: "Piper kilka razy zawiódł, odpoczywa minutę.", DROPPED: "Piper jest zajęty, spróbuj znowu.",
      NO_PAIR: "Najpierw wpisz !ai w grze.", WING_UNAVAILABLE: "Okna wingu nie ma na tym serwerze.",
      BOARD_UNAVAILABLE: "Okna tablicy nie ma na tym serwerze.",
      UNAVAILABLE_MAIL: "Czytnik maili jest wyłączony na tym serwerze.", CLIENT_NOT_READY: "Klient gry nie jest gotowy.",
      NO_CLIENT: "Nie masz połączonego klienta czatu." },
  });

  function reasonText(reason) {
    const table = REASON_TEXT[state.lang.slice(0, 2)] || REASON_TEXT.en;
    const max = state.options && state.options.persona ? state.options.persona.customMaxChars : 0;
    const text = Object.prototype.hasOwnProperty.call(table, reason) ? table[reason] : `Refused (${reason}).`;
    return text.replace("{max}", String(max));
  }

  async function api(name, method, body) {
    const opts = { method, cache: "no-store", credentials: "omit", headers: { "X-LNE-Voice": state.sid } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    try {
      const res = await global.fetch(`${API}${name}`, opts);
      const json = await res.json();
      return json && typeof json === "object" ? json : { ok: false, reason: "BAD_ANSWER" };
    } catch (_err) {
      return { ok: false, reason: "UNAVAILABLE" };
    }
  }

  function addOption(parent, value, label) {
    const o = doc.createElement("option");
    o.value = value;
    o.textContent = label;
    parent.appendChild(o);
    return o;
  }

  function choiceValue(choice) {
    if (!choice) return "";
    if (choice.engine === "browser" && choice.browser) return `${BROWSER_PREFIX}${choice.browser}`;
    if (choice.piper) return `${PIPER_PREFIX}${choice.piper}`;
    return "";
  }

  function fillVoiceSelect() {
    const sel = el("voiceSel");
    const keep = sel.options.length > 0 ? sel.value : choiceValue(state.choice);
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    const groups = voiceOptions(state.options.piper.voices, synth ? synth.getVoices() : [], state.lang,
      state.settings.allowRemote);
    for (const g of groups) {
      const parent = g.label === null ? sel : sel.appendChild(doc.createElement("optgroup"));
      if (g.label !== null) parent.label = g.label;
      for (const o of g.options) addOption(parent, o.value, o.label);
    }
    sel.value = keep;
    if (sel.value !== keep) sel.value = "";
    formChanged();
  }

  function setForm(choice) {
    const d = state.options.defaults;
    const c = choice || {};
    el("rate").value = String((c.rateMilli || d.rateMilli) / MILLI);
    el("pitch").value = String((c.pitchMilli || d.pitchMilli) / MILLI);
    el("radio").checked = c.radio === null || c.radio === undefined ? d.radio !== false : c.radio === true;
    el("voiceSel").value = choiceValue(choice);
    if (el("voiceSel").value !== choiceValue(choice)) el("voiceSel").value = "";
    const missing = choice && choice.piper && !state.options.piper.voices.some((v) => v.id === choice.piper);
    el("voiceNote").textContent = missing ? "saved voice not on server, using default"
      : state.options.piper.status === "UNAVAILABLE" ? "Piper voices unavailable now" : "";
    formChanged();
  }

  function form() {
    return { value: el("voiceSel").value, rate: el("rate").value, pitch: el("pitch").value,
      radio: el("radio").checked, serverEngine: state.options ? state.options.engine : "browser" };
  }

  function formChanged() {
    const body = choiceFromForm(form());
    el("rateVal").textContent = `${Number(el("rate").value).toFixed(2)}x`;
    el("pitchVal").textContent = Number(el("pitch").value).toFixed(2);
    el("pitch").disabled = body.pitchMilli === null;
    el("radio").disabled = body.radio === null;
  }

  function fillPersona() {
    const p = state.options.persona;
    const sel = el("personaSel");
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    for (const preset of Array.isArray(p.presets) ? p.presets : []) addOption(sel, preset.id, preset.label);
    sel.value = p.stored && p.stored.preset ? p.stored.preset : p.defaultPreset;
    const text = el("personaText");
    text.maxLength = p.customMaxChars;
    text.value = p.stored && p.stored.custom ? p.stored.custom : "";
    personaChanged();
  }

  function personaChanged() {
    el("personaText").classList.toggle("hidden", el("personaSel").value !== "custom");
  }

  async function loadOptions() {
    if (!state.sid) return;
    const body = await api("options", "GET");
    if (!body.ok || !body.piper || !body.defaults || !body.persona) return;
    state.options = body;
    state.choice = body.choice || null;
    fillVoiceSelect();
    setForm(state.choice);
    fillPersona();
    chooseVoice();
    el("voicePanel").classList.remove("hidden");
    el("personaPanel").classList.remove("hidden");
  }

  async function saveChoice(body) {
    const r = await api("voice", "POST", body);
    if (!r.ok) {
      show(reasonText(r.reason));
      return;
    }
    state.choice = r.choice || null;
    setForm(state.choice);
    chooseVoice();
    show(state.choice ? "Voice saved. The next lines use it." : "Voice back to the server default.");
  }

  function unlockAudio() {
    if (!AudioCtx) return null;
    try {
      if (!state.audio) state.audio = new AudioCtx();
      const resumed = state.audio.resume();
      if (resumed && typeof resumed.catch === "function") resumed.catch(() => {});
    } catch (_err) {
      state.audio = null;
    }
    return state.audio;
  }

  async function piperTest(body) {
    const ctx = unlockAudio();
    if (!ctx) {
      show("This browser cannot play the Piper audio.");
      return;
    }
    show("Piper test...");
    const r = await api("test", "POST", { voice: body.piper, rateMilli: body.rateMilli });
    if (!r.ok || typeof r.audioId !== "string" || !AUDIO_ID_RE.test(r.audioId)) {
      show(reasonText(r.reason));
      return;
    }
    let buffer = null;
    try {
      const res = await global.fetch(`${API}audio/${r.audioId}`, { headers: { "X-LNE-Voice": state.sid },
        cache: "no-store", credentials: "omit" });
      if (res.ok) buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    } catch (_err) {
      buffer = null;
    }
    if (!buffer) {
      show("The Piper test audio did not play.");
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(body.radio === false ? ctx.destination : radioInput(ctx));
    src.start();
    show("Piper test.");
  }

  function browserTest(over) {
    if (!synth || !state.settings) return;
    const voice = over && over.voice !== undefined ? over.voice : state.voice;
    if (!voice) {
      noVoiceHint();
      return;
    }
    synth.speak(utterance(TEST_TEXT[state.lang.slice(0, 2)] || TEST_TEXT.en, { ...(over || {}), voice }));
  }

  function renderPanel(view) {
    state.panel = view;
    const box = el("panelPanel");
    const pressed = panelPressed(view);
    const wingOn = Boolean(view.wing && view.wing.available === true);
    const boardOn = Boolean(view.board && view.board.available === true);
    for (const b of box.querySelectorAll("[data-switch]")) {
      const id = b.getAttribute("data-switch");
      b.setAttribute("aria-pressed", String(pressed[id] === true));
      b.disabled = (id === "wingOpenAtLogin" && !wingOn) || (id === "boardOpenAtLogin" && !boardOn);
    }
    for (const b of box.querySelectorAll("[data-mail]")) {
      b.setAttribute("aria-pressed", String(pressed.mail === b.getAttribute("data-mail")));
      b.disabled = pressed.mail === null;
    }
    for (const b of box.querySelectorAll("[data-action]")) {
      const action = b.getAttribute("data-action");
      b.disabled = (action === "openWing" && !wingOn) || (action === "openBoard" && !boardOn);
    }
    el("panelNote").textContent = view.paired !== true ? "type !ai in the game first"
      : view.autostartServer === false ? "the autostart is off on this server" : "";
  }

  async function loadPanel() {
    if (!state.sid) return;
    const body = await api("panel", "GET");
    if (!body.ok || !body.panel) return;
    renderPanel(body.panel);
    el("panelPanel").classList.remove("hidden");
  }

  async function sendPanelSwitch(id, value) {
    const r = await api("panel", "POST", { id, value });
    if (!r.ok || !r.panel) {
      show(reasonText(r.reason === "UNAVAILABLE" && id === "mail" ? "UNAVAILABLE_MAIL" : r.reason));
      if (r.reason !== "RATE_LIMITED") loadPanel();
      return;
    }
    renderPanel(r.panel);
    show(`${id}: ${r.value}`);
  }

  async function sendPanelAction(id) {
    const r = await api("panel/action", "POST", { id });
    if (!r.ok) {
      show(reasonText(r.reason));
      return;
    }
    show(id === "inviteRoom" ? "Invitation sent. Accept it in the game."
      : id === "openBoard" ? "The board window goes to the game." : "The wing window goes to the game.");
  }

  async function openSession(token) {
    try {
      const res = await global.fetch(`${API}session`, { method: "POST", cache: "no-store", credentials: "omit",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const body = await res.json();
      if (!res.ok || !body || body.ok !== true) {
        show("This link is used or expired. Type !ai voice in the game for a new one.");
        return;
      }
      state.sid = body.sid;
      storeSid(body.sid);
      ready(body);
      try {
        global.sessionStorage.setItem(`${SID_KEY}-info`, JSON.stringify({ settings: body.settings, lang: body.lang,
          aiName: body.aiName, choice: body.choice || null }));
      } catch (_err) {
      }
    } catch (_err) {
      show("The game server did not answer. Is the observer on?");
    }
  }

  function resume(sid) {
    let info = null;
    try {
      info = JSON.parse(global.sessionStorage.getItem(`${SID_KEY}-info`) || "null");
    } catch (_err) {
      info = null;
    }
    if (!info || !info.settings) {
      show("Type !ai voice in the game to get a link to this page.");
      return;
    }
    state.sid = sid;
    ready(info);
  }

  el("start").addEventListener("click", () => {
    if (!state.sid) return;
    if (piperOn()) unlockAudio();
    if (!synth && !state.audio) return;
    if (synth) synth.speak(new global.SpeechSynthesisUtterance(""));
    state.running = true;
    enable(["stop", "skip", "mute"], true);
    el("start").disabled = true;
    if (!state.voice && !state.audio) noVoiceHint();
    else show("Listening. Your ship AI speaks here as soon as it writes to you.");
    schedule(0);
  });
  el("stop").addEventListener("click", () => {
    halt("Stopped. Press Start to listen again.");
    el("start").disabled = !state.sid;
  });
  el("skip").addEventListener("click", () => {
    if (!state.current) return;
    const cur = state.current;
    cur.index = cur.parts.length;
    cur.speaking = false;
    cur.audioId = null;
    stopSource();
    if (synth) synth.cancel();
    speakNext();
  });
  el("test").addEventListener("click", () => {
    if (!state.settings) return;
    if (!state.options) {
      browserTest(null);
      if (piperOn()) show("Test voice plays the browser fallback voice. Piper speaks the lines of the AI after Start.");
      return;
    }
    const body = choiceFromForm(form());
    const piper = body.engine === "piper" || (body.engine === null && state.options.engine === "piper");
    if (piper) {
      piperTest(body);
      return;
    }
    const wanted = body.browser || (state.settings.voiceName || "");
    const voice = synth ? pickVoice(synth.getVoices(), state.lang, wanted, state.settings.allowRemote) : null;
    browserTest({ voice, rateMilli: body.rateMilli, pitchMilli: body.pitchMilli });
  });
  el("voiceSel").addEventListener("change", formChanged);
  el("rate").addEventListener("input", formChanged);
  el("pitch").addEventListener("input", formChanged);
  el("save").addEventListener("click", () => {
    if (state.sid && state.options) saveChoice(choiceFromForm(form()));
  });
  el("reset").addEventListener("click", () => {
    if (state.sid && state.options) saveChoice({});
  });
  el("personaSel").addEventListener("change", personaChanged);
  async function sendPersona(body) {
    const r = await api("persona", "POST", body);
    if (!r.ok || !r.persona) {
      show(reasonText(r.reason));
      return;
    }
    state.options.persona = r.persona;
    fillPersona();
    show(`Persona: ${r.persona.preset}.`);
  }
  el("personaApply").addEventListener("click", () => {
    if (!state.sid || !state.options) return;
    const preset = el("personaSel").value;
    sendPersona(preset === "custom" ? { action: "custom", text: el("personaText").value }
      : { action: "set", preset });
  });
  el("personaReset").addEventListener("click", () => {
    if (state.sid && state.options) sendPersona({ action: "reset" });
  });
  el("mute").addEventListener("click", () => {
    state.muted = !state.muted;
    el("mute").textContent = state.muted ? "Unmute" : "Mute";
    if (state.muted) {
      stopSource();
      if (synth) synth.cancel();
      state.queue.length = 0;
      state.current = null;
    }
  });
  el("panelPanel").addEventListener("click", (ev) => {
    const b = ev.target && typeof ev.target.closest === "function" ? ev.target.closest("button") : null;
    if (!b || b.disabled || !state.sid || !state.panel) return;
    if (b.hasAttribute("data-switch")) {
      sendPanelSwitch(b.getAttribute("data-switch"), b.getAttribute("aria-pressed") === "true" ? "off" : "on");
    } else if (b.hasAttribute("data-mail")) sendPanelSwitch("mail", b.getAttribute("data-mail"));
    else if (b.hasAttribute("data-action")) sendPanelAction(b.getAttribute("data-action"));
  });
  if (synth && typeof synth.addEventListener === "function") synth.addEventListener("voiceschanged", chooseVoice);

  const token = tokenOf(global.location.hash);
  if (token) {
    if (global.history && typeof global.history.replaceState === "function") {
      global.history.replaceState(null, "", global.location.pathname);
    }
    openSession(token);
  } else {
    const sid = readSid();
    if (sid) resume(sid);
  }
})(typeof window !== "undefined" ? window : globalThis);
