"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const { resolveConfig, SCHEMA } = require("../../config");
const S = require("../../lib/shipAi/schema");
const VP = require("../../lib/shipAi/voice/voicePrefs");
const { parsePiperUrl, createPiperTransport } = require("../../lib/shipAi/voice/piperTransport");
const { createAudioCache } = require("../../lib/shipAi/voice/audioCache");
const { createPiperEngine } = require("../../lib/shipAi/voice/piperEngine");
const { createVoiceQueue } = require("../../lib/shipAi/voice/queue");
const { createVoiceRoutes } = require("../../lib/shipAi/voice/routes");
const { createSessions } = require("../../lib/modSettings/web/sessions");
const { createHttpRoutes } = require("../../lib/observer/httpRoutes");
const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
const { startShipAi } = require("../../lib/shipAi");
const P = require("../../lib/shipAi/data/personaPresets");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_DIR = path.resolve(MOD_DIR, "..", "..");
const PLAYER = 9001;
const OTHER = 9002;
const AI = 91000001;
const JITA = 30000142;
const T0 = 1700000000000;
const KEY = "test-key-not-real-0123";
const XMPP = { transport: "xmpp" };
const ORIGIN = "http://127.0.0.1:26410";
const GOSIA = "pl_PL-gosia-medium";
const DARKMAN = "pl_PL-darkman-medium";

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
const V = { ...S.shipAiVoiceSettingsOf(base).settings };
const LIM = { piperVoices: new Set([GOSIA, DARKMAN]), rateRange: [500, 2000], pitchRange: [500, 2000] };

const mutableClock = () => {
  let now = T0;
  return { now: () => now, advance: (ms) => { now += ms; } };
};
const counterBytes = () => {
  let n = 0;
  return (size) => {
    n += 1;
    return Buffer.alloc(size, n % 256);
  };
};
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const wav = () => {
  const b = Buffer.alloc(32, 1);
  b.write("RIFF", 0, "latin1");
  b.write("WAVE", 8, "latin1");
  return b;
};

function fakeRequest() {
  const calls = [];
  const request = (url, opts, cb) => {
    const req = new EventEmitter();
    const call = { url, opts, body: null, cb };
    req.end = (payload) => {
      call.body = payload === undefined ? null : JSON.parse(Buffer.from(payload).toString("utf8"));
    };
    req.destroy = () => {};
    calls.push(call);
    return req;
  };
  const answer = (i, { status = 200, chunks = [wav()] } = {}) => {
    const res = new EventEmitter();
    res.statusCode = status;
    res.headers = {};
    res.resume = () => {};
    calls[i].cb(res);
    for (const c of chunks) res.emit("data", c);
    res.emit("end");
  };
  return { calls, request, answer };
}

function fakeRes() {
  return { writes: 0, status: 0, headers: null, body: "", writeHead(status, headers) {
    this.writes += 1;
    this.status = status;
    this.headers = headers;
  }, end(body) {
    this.body = String(body || "");
  }, json() {
    return JSON.parse(this.body);
  } };
}

function call(route, method, url, opts = {}) {
  const res = fakeRes();
  route.handle({ method, url, headers: opts.headers || {} }, res, opts.body === undefined ? null
    : Buffer.from(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)));
  return res;
}

module.exports = ({ test, skip }) => {
  test("VPK1 voicePrefs: Piper and browser accepted, BAD_PIPER_VOICE / PIPER_UNAVAILABLE / BAD_RATE / "
    + "BAD_BROWSER_VOICE, all null = null, characterId ignored, a bad text reads null, lengthScaleOf, label", () => {
    const a = VP.normalizeVoicePrefs({ engine: "piper", piper: DARKMAN, rateMilli: 1200, radio: false,
      characterId: OTHER }, LIM);
    assert.deepStrictEqual(a, { ok: true, prefs: { v: 1, engine: "piper", piper: DARKMAN, browser: null,
      rateMilli: 1200, pitchMilli: null, radio: false } });
    const b = VP.normalizeVoicePrefs({ engine: "browser", browser: "Microsoft Paulina", pitchMilli: 900 }, LIM);
    assert.deepStrictEqual([b.ok, b.prefs.browser, b.prefs.pitchMilli, "characterId" in b.prefs],
      [true, "Microsoft Paulina", 900, false]);
    const reason = (input, lim = LIM) => VP.normalizeVoicePrefs(input, lim).reason;
    assert.deepStrictEqual([reason({ piper: "pl_PL-nobody-medium" }), reason({ piper: GOSIA }, { ...LIM,
      piperVoices: null }), reason({ rateMilli: 499 }), reason({ rateMilli: 1.5 }), reason({ browser: "a\u0007b" }),
    reason({ browser: "x".repeat(129) }), reason({ engine: "edge" }), reason({ radio: "yes" }), reason([])],
    ["BAD_PIPER_VOICE", "PIPER_UNAVAILABLE", "BAD_RATE", "BAD_RATE", "BAD_BROWSER_VOICE", "BAD_BROWSER_VOICE",
      "BAD_ENGINE", "BAD_RADIO", "BAD_BODY"]);
    assert.deepStrictEqual(VP.normalizeVoicePrefs({ engine: null, piper: null, rateMilli: null }, LIM),
      { ok: true, prefs: null });
    assert.deepStrictEqual(VP.normalizeVoicePrefs({}, LIM), { ok: true, prefs: null });
    assert.strictEqual(VP.parseVoicePrefs("{bad"), null);
    assert.strictEqual(VP.parseVoicePrefs(JSON.stringify({ v: 2, engine: "piper" })), null);
    assert.deepStrictEqual(VP.parseVoicePrefs(JSON.stringify(a.prefs)), a.prefs);
    assert.deepStrictEqual([VP.lengthScaleOf(1000, 2000), VP.lengthScaleOf(1000, 500), VP.lengthScaleOf(1000, null),
      VP.lengthScaleOf(1000, 1250), VP.lengthScaleOf(1500, 500)], [500, 2000, 1000, 800, 2000]);
    assert.deepStrictEqual([VP.piperVoiceLabel("pl_PL-mc_speech-medium"), VP.piperVoiceLabel("pl_PL-bass-high")],
      ["mc_speech (medium)", "bass (high)"]);
  });

  test("VPK2 engine on a fake request: GET /voices parsed (regex + language), 2 parallel = 1 request, cached in "
    + "the TTL; synthesize with the voice and length_scale of the choice; a voice of another language = default",
  async () => {
    const clock = mutableClock();
    const f = fakeRequest();
    const transport = createPiperTransport({ request: f.request, timeoutSignal: () => new AbortController().signal });
    const parsed = parsePiperUrl("http://piper:5000");
    assert.strictEqual(parsed.voicesUrl.href, "http://piper:5000/voices");
    const cache = createAudioCache({ maxBytes: 65536, storeMaxBytes: V.voicePiperMaxBytes, nowMs: clock.now,
      randomBytes: counterBytes() });
    const e = createPiperEngine({ S: V, transport, cache, url: parsed.synthesizeUrl, voicesUrl: parsed.voicesUrl,
      nowMs: clock.now });
    assert.strictEqual(e.knownVoices("pl-PL"), null);
    const p1 = e.listVoices("pl-PL");
    const p2 = e.listVoices("pl-PL");
    await flush();
    assert.strictEqual(f.calls.length, 1, "two callers join one request");
    assert.deepStrictEqual([f.calls[0].opts.method, f.calls[0].url.href, f.calls[0].body, f.calls[0].opts.headers.accept],
      ["GET", "http://piper:5000/voices", null, "application/json"]);
    const list = { "pl_PL-gosia-medium": {}, "pl_PL-darkman-medium": {}, "en_US-x-medium": {}, "pl_PL-bad.": {} };
    f.answer(0, { chunks: [Buffer.from(JSON.stringify(list))] });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepStrictEqual([r1.voices, r2.voices], [[DARKMAN, GOSIA], [DARKMAN, GOSIA]]);
    const r3 = await e.listVoices("pl-PL");
    assert.deepStrictEqual([r3.cached, f.calls.length], [true, 1], "inside the TTL no request");
    assert.deepStrictEqual([...e.knownVoices("pl-PL")], [DARKMAN, GOSIA]);

    const s1 = e.synthesize(PLAYER, "Linia testowa.", "pl-PL", { voice: DARKMAN, lengthScaleMilli: 800 });
    await flush();
    assert.deepStrictEqual(f.calls[1].body, { text: "Linia testowa.", voice: DARKMAN, length_scale: 0.8 });
    f.answer(1);
    assert.strictEqual((await s1).ok, true);
    const s2 = e.synthesize(PLAYER, "Druga linia.", "pl-PL", { voice: "en_US-x-medium" });
    await flush();
    assert.deepStrictEqual(f.calls[2].body, { text: "Druga linia.", voice: GOSIA, length_scale: 1 });
    f.answer(2);
    await s2;
    assert.strictEqual(e.status().voicesListed, 1);
    e.stop();
  });

  test("VPK3 routes: 401 without sid, 403 foreign Origin, the save goes to the session character, 429 with waitMs, "
    + "TEST_TIMEOUT answered exactly once, voicePickerEnabled false = 404", async () => {
    const clock = mutableClock();
    const sessions = createSessions({ linkTtlMs: V.voiceLinkTtlMs, sessionTtlMs: V.voiceSessionTtlMs,
      maxSessions: V.voiceMaxSessions, clock, randomBytes: counterBytes() });
    const queue = createVoiceQueue({ S: V, nowMs: clock.now, randomBytes: counterBytes() });
    const saved = [];
    let hang = null;
    const engine = { listVoices: async () => ({ ok: true, voices: [GOSIA], cached: false }),
      knownVoices: () => new Set([GOSIA]),
      synthesize: () => new Promise((resolve) => { hang = resolve; }) };
    const timer = new AbortController();
    const make = (on) => createVoiceRoutes({ sessions, queue,
      settingsOf: () => ({ aiName: "Jin", lang: "pl-PL", settings: {} }),
      picker: { S: { ...V, voicePickerEnabled: on }, lang: "pl-PL", nowMs: clock.now, engine,
        voicePrefs: { get: () => null, save: (playerId, prefs) => {
          saved.push({ playerId, prefs });
          return { ok: true, prefs };
        } },
        persona: { view: () => ({ preset: "default" }), apply: () => ({ ok: true }) },
        timeoutSignal: () => timer.signal } });
    const route = make(true);
    const token = sessions.issueToken({ characterId: PLAYER, characterName: "Pilot One" }).token;
    const opened = call(route, "POST", "/api/shipai/session", { body: { token }, headers: { origin: ORIGIN } });
    const sid = opened.json().sid;
    assert.strictEqual(opened.json().choice, null);
    const h = (extra) => ({ "x-lne-voice": sid, origin: ORIGIN, ...(extra || {}) });

    assert.deepStrictEqual([call(route, "GET", "/api/shipai/options").status,
      call(route, "POST", "/api/shipai/voice", { body: {}, headers: h({ origin: "http://evil.example" }) }).status],
    [401, 403]);
    const ok = call(route, "POST", "/api/shipai/voice", { body: { browser: "Paulina", characterId: OTHER },
      headers: h() });
    await flush();
    assert.strictEqual(ok.status, 200, ok.body);
    assert.deepStrictEqual(saved.map((s) => [s.playerId, s.prefs.browser]), [[PLAYER, "Paulina"]]);
    const again = call(route, "POST", "/api/shipai/voice", { body: { browser: "Zosia" }, headers: h() });
    await flush();
    assert.deepStrictEqual([again.status, again.json().reason, again.json().waitMs > 0], [429, "RATE_LIMITED", true]);

    const t = call(route, "POST", "/api/shipai/test", { body: {}, headers: h() });
    await flush();
    assert.strictEqual(t.writes, 0, "the engine still works");
    timer.abort();
    await flush();
    assert.deepStrictEqual([t.status, t.json().reason, t.writes], [504, "TEST_TIMEOUT", 1]);
    hang({ ok: true, audioId: "a".repeat(22), cached: false });
    await flush();
    assert.strictEqual(t.writes, 1, "the late audio writes nothing");
    const st = route.status();
    assert.deepStrictEqual([st.choicesSaved, st.tests, st.refused_RATE_LIMITED, st.refused_TEST_TIMEOUT], [1, 1, 1, 1]);

    const off = make(false);
    assert.deepStrictEqual(["options", "voice", "test", "persona"].map((n) => call(off, n === "options" ? "GET" : "POST",
      `/api/shipai/${n}`, { body: {}, headers: h() }).status), [404, 404, 404, 404]);
  });

  test("VPK7 debt-sweep: getStatus refused_RATE_LIMITED = picker routes 2 + `!ai voice` 3 = 5; picker off = 3", async () => {
    const { createShipAiVoice } = require("../../lib/shipAi/voice");
    const statusWith = async (pickerOn) => {
      const clock = mutableClock();
      const httpRoutes = createHttpRoutes();
      const made = createShipAiVoice({ S: { ...V, voicePickerEnabled: pickerOn }, nowMs: clock.now,
        randomBytes: counterBytes(), httpRoutes, observerUrl: () => ({ ok: true, url: `${ORIGIN}/` }),
        aiNameOf: () => "Jin", voicePrefs: { get: () => null, save: (_id, prefs) => ({ ok: true, prefs }) },
        persona: { view: () => ({ preset: "default" }), apply: () => ({ ok: true }) } });
      assert.ok(made.ok, JSON.stringify(made));
      const voice = made.voice;
      try {
        const first = voice.link(PLAYER, "Pilot One");
        assert.ok(first.ok, JSON.stringify(first));
        for (let i = 0; i < 3; i += 1) assert.strictEqual(voice.link(PLAYER, "Pilot One").reason, "RATE_LIMITED");
        if (pickerOn) {
          const route = httpRoutes.match("/api/shipai/session");
          const token = /#t=([A-Za-z0-9_-]{43})/.exec(first.href)[1];
          const sid = call(route, "POST", "/api/shipai/session", { body: { token }, headers: { origin: ORIGIN } })
            .json().sid;
          const h = { "x-lne-voice": sid, origin: ORIGIN };
          const codes = [];
          for (let i = 0; i < 3; i += 1) {
            codes.push(call(route, "POST", "/api/shipai/voice", { body: { browser: "Paulina" }, headers: h }));
            await flush();
          }
          assert.deepStrictEqual(codes.map((r) => r.status), [200, 429, 429]);
        }
        return voice.getStatus().refused_RATE_LIMITED;
      } finally {
        voice.stop();
      }
    };
    assert.strictEqual(await statusWith(true), 5);
    assert.strictEqual(await statusWith(false), 3);
  });

  const driver = SH.loadDriver();
  const vpk4 ="VPK4 one persona path + restart: !ai persona and POST persona write the same row (version + 1 each), "
    + "a link refused LINK in both paths (counter 2), the voice choice survives a restart, migration 93";
  if (!driver.ok) skip(vpk4, `better-sqlite3 unavailable (${driver.detail})`);
  else {
    test(vpk4, () => SH.withStoreAsync(driver, async (persistence) => {
      const { store } = persistence;
      const tx = (fn) => {
        const r = store.transaction("t.picker", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const repo = createShipAiPrefsRepository();
      const rowOf = () => tx((db) => repo.getByPlayer(db, PLAYER)).row;
      const { MIGRATIONS } = require("../../lib/persistence/migrations");
      const at = MIGRATIONS.findIndex((m) => m.name === "ship_ai_prefs_voice");
      assert.deepStrictEqual([MIGRATIONS[at].version, MIGRATIONS[at - 1].name, MIGRATIONS[at].up],
        [93, "ship_ai_triggers", S.upShipAiPrefsVoice]);
      assert.ok(tx((db) => repo.insert(db, { playerId: PLAYER, aiId: AI, name: "Jin", nowMs: 1000 })).ok);

      const boot = () => {
        const clock = mutableClock();
        const httpRoutes = createHttpRoutes();
        const adapter = { shipAiSeams: () => ({ ok: true, seam: { identities: {
          corporationExists: () => ({ ok: true, exists: true }), writeCharacter: () => ({ ok: true }),
          flush: () => ({ ok: true }) }, xmpp: {}, channel: () => null } }),
        installChatCommand: () => ({ ok: true }), uninstallChatCommand: () => ({ ok: true }),
        readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER, name: "Pilot One", systemId: JITA,
          state: "docked" }] }),
        sendCharacterSystemLine: () => ({ ok: true }), readStaticMap: () => ({ ok: false, reason: "TEST" }) };
        const config = { ...base, observer: { ...base.observer, enabled: true, port: 26410 },
          inGameMap: { ...(base.inGameMap || {}), observerUrl: "" },
          shipAi: { ...base.shipAi, channel: "local", allowCharacterIds: "*", apiKey: KEY, minIntervalMs: 0,
            toolMode: "off", memoryEnabled: false, proactiveEnabled: false, mailEnabled: false, portraitEnabled: false,
            voiceEnabled: true } };
        const started = startShipAi({ config, persistence, adapter, clock, httpRoutes, randomBytes: counterBytes(),
          transport: { post: () => new Promise(() => {}) }, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
        assert.strictEqual(started.ok, true, JSON.stringify(started));
        const ai = started.shipAi;
        const say = (text) => ai.handle({ characterId: PLAYER, name: "Pilot One", systemId: JITA }, text, XMPP);
        const m = /#t=([A-Za-z0-9_-]{43})"/.exec(say("!ai voice"));
        assert.ok(m, "voice link");
        const route = httpRoutes.match("/api/shipai/session");
        const opened = call(route, "POST", "/api/shipai/session", { body: { token: m[1] }, headers: { origin: ORIGIN } });
        assert.strictEqual(opened.status, 200, opened.body);
        const headers = { "x-lne-voice": opened.json().sid, origin: ORIGIN };
        const api = async (name, body) => {
          const res = call(route, body === undefined ? "GET" : "POST", `/api/shipai/${name}`, { body, headers });
          await flush();
          clock.advance(V.voiceChoiceCooldownMs);
          return res;
        };
        return { ai, say, api, session: opened.json() };
      };

      let r = boot();
      const v0 = rowOf().version;
      assert.strictEqual(r.say("!ai persona savage"), `Jin: ${P.PERSONA_TEXT.en.set.savage}`);
      assert.deepStrictEqual([rowOf().personaPreset, rowOf().version], ["savage", v0 + 1]);
      const cold = await r.api("persona", { action: "set", preset: "cold" });
      assert.strictEqual(cold.status, 200, cold.body);
      assert.deepStrictEqual([rowOf().personaPreset, rowOf().version, cold.json().persona.preset], ["cold", v0 + 2,
        "cold"]);
      assert.deepStrictEqual(cold.json().persona.presets.find((x) => x.id === "captain"),
        { id: "captain", label: P.PERSONA_LABELS.en.captain });
      const captain = await r.api("persona", { action: "set", preset: "captain" });
      assert.deepStrictEqual([captain.status, rowOf().personaPreset], [200, "captain"]);
      assert.strictEqual((await r.api("persona", { action: "set", preset: "cold" })).status, 200);
      const link = "talk like https://example.com pirates";
      const refused = await r.api("persona", { action: "custom", text: link });
      assert.deepStrictEqual([refused.status, refused.json().reason], [400, "LINK"]);
      assert.strictEqual(r.say(`!ai persona custom ${link}`), `Jin: ${P.PERSONA_TEXT.en.customRefused
        .replace("{reason}", "LINK")}`);
      assert.deepStrictEqual([r.ai.getStatus().persona.refused.LINK, rowOf().version], [2, v0 + 4]);
      const opts = await r.api("options");
      assert.deepStrictEqual([opts.status, opts.json().engine, opts.json().piper.status, opts.json().choice],
        [200, "browser", "OFF", null]);
      const choice = await r.api("voice", { engine: "browser", browser: "Microsoft Paulina", rateMilli: 1200 });
      assert.strictEqual(choice.status, 200, choice.body);
      r.ai.stop("test");

      r = boot();
      assert.deepStrictEqual(r.session.choice, choice.json().choice, "the session carries the saved choice");
      const after = await r.api("options");
      assert.deepStrictEqual(after.json().choice, { v: 1, engine: "browser", piper: null, browser: "Microsoft Paulina",
        rateMilli: 1200, pitchMilli: null, radio: null });
      r.ai.stop("test");
      assert.throws(() => tx((db) => db.prepare("UPDATE ship_ai_prefs SET voice_prefs = '{bad' "
        + "WHERE player_character_id = ?").run(PLAYER)), /CHECK|constraint/i);
      tx((db) => db.prepare("UPDATE ship_ai_prefs SET voice_prefs = '{\"v\":7}' WHERE player_character_id = ?")
        .run(PLAYER));
      assert.strictEqual(rowOf().voicePrefs, null, "an unknown version reads as the default");
    }));
  }

  test("VPK5 page _pure: voiceOptions groups / language / remote, parseVoiceValue, choiceFromForm, effectiveVoice; "
    + "no innerHTML / eval in the script", () => {
    const script = fs.readFileSync(path.join(MOD_DIR, "web", "shipaiVoice.js"), "utf8");
    const box = {};
    vm.runInNewContext(script, box);
    const p = box.LneShipAiVoice._pure;
    const browser = [{ name: "Paulina", lang: "pl-PL", localService: true },
      { name: "Google polski", lang: "pl-PL", localService: false }, { name: "David", lang: "en-US", localService: true }];
    const groups = p.voiceOptions([{ id: GOSIA, label: "gosia (medium)" }], browser, "pl-PL", false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(groups.map((g) => [g.label, g.options.map((o) => o.value)]))), [
      [null, [""]], ["Piper (server)", [`piper:${GOSIA}`]], ["This browser", ["browser:Paulina"]]]);
    assert.strictEqual(p.voiceOptions([], browser, "pl-PL", true)[1].options.length, 2, "remote with allowRemote");
    assert.deepStrictEqual(JSON.parse(JSON.stringify([p.parseVoiceValue(`piper:${GOSIA}`), p.parseVoiceValue(""),
      p.parseVoiceValue("browser:Paulina")])), [{ engine: "piper", id: GOSIA }, null,
      { engine: "browser", id: "Paulina" }]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.choiceFromForm({ value: `piper:${DARKMAN}`, rate: "1.25",
      pitch: "0.9", radio: false, serverEngine: "piper" }))), { engine: "piper", piper: DARKMAN, browser: null,
      rateMilli: 1250, pitchMilli: null, radio: false });
    const settings = { engine: "piper", rateMilli: 1000, pitchMilli: 1100, radioFilter: true, voiceName: "" };
    assert.strictEqual(p.effectiveVoice(settings, { engine: "browser" }).piperOn, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.effectiveVoice(settings, null))), { piperOn: true,
      rateMilli: 1000, pitchMilli: 1100, radio: true, voiceName: "" });
    for (const bad of ["innerHTML", "eval("]) assert.ok(!script.includes(bad), bad);
  });

  test("VPK6 voices.txt: 5 fields, 40-hex revision, 64-hex sha256, unique names of PIPER_NAME_RE, the default pl "
    + "voice and the 4 Polish voices", () => {
    const lines = fs.readFileSync(path.join(REPO_DIR, "docker", "piper", "voices.txt"), "utf8").split(/\r?\n/)
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).map((l) => l.split("|").map((x) => x.trim()));
    for (const f of lines) {
      assert.strictEqual(f.length, 5, f.join("|"));
      assert.ok(VP.PIPER_NAME_RE.test(f[0]) && /^[0-9a-f]{40}$/.test(f[1]) && /^[0-9a-f]{64}$/.test(f[2])
        && /^[0-9a-f]{64}$/.test(f[3]) && f[4] !== "", f[0]);
    }
    const names = lines.map((f) => f[0]);
    assert.strictEqual(new Set(names).size, names.length, "unique names");
    const def = SCHEMA.find((row) => row.key === "shipAi.voicePiperVoicePl").default;
    assert.ok(names.includes(def), def);
    assert.deepStrictEqual(names.filter((n) => n.startsWith("pl_")).sort(), ["pl_PL-bass-high", DARKMAN, GOSIA,
      "pl_PL-mc_speech-medium"]);
  });
};
