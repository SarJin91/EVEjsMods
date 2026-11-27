"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig, SCHEMA } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { toSpeechText, splitSentences, langTagOf } = require("../../lib/shipAi/voice/speechText");
const { createVoiceQueue } = require("../../lib/shipAi/voice/queue");
const { createVoiceRoutes } = require("../../lib/shipAi/voice/routes");
const { createSessions } = require("../../lib/modSettings/web/sessions");
const { createHttpRoutes } = require("../../lib/observer/httpRoutes");
const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
const { startShipAi } = require("../../lib/shipAi");
const { ASSET_FILES } = require("../../lib/observer");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PLAYER = 9001;
const OTHER = 9002;
const AI = 91000001;
const AI2 = 91000002;
const JITA = 30000142;
const T0 = 1700000000000;
const KEY = "test-key-not-real-0123";
const XMPP = { transport: "xmpp" };
const ORIGIN = "http://127.0.0.1:26410";
const SECRET_LINE = "Captain, the cargo of Pilot One holds 3 Raven blueprints.";

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
const V = { ...S.shipAiVoiceSettingsOf(base).settings };

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

function fakeRes() {
  return { status: 0, headers: null, body: "", writeHead(status, headers) {
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

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const completion = (content) => ({ ok: true, status: 200,
  json: { choices: [{ message: { content }, finish_reason: "stop" }], usage: { total_tokens: 100 } } });

function deferredTransport() {
  const calls = [];
  return { calls, post(spec) {
    return new Promise((resolve) => calls.push({ spec, resolve }));
  } };
}

function insertPrefs(store, playerId, aiId) {
  const r = store.transaction("t.prefs", (db) => createShipAiPrefsRepository().insert(db,
    { playerId, aiId, name: "Jin", nowMs: 1000 }));
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
}

function service(persistence, opts = {}) {
  const logs = [];
  const metrics = [];
  const system = [];
  const httpRoutes = createHttpRoutes();
  const presence = () => ({ ok: true, characters: [{ characterId: PLAYER, name: "Pilot One", systemId: JITA,
    state: "docked" }, { characterId: OTHER, name: "Rival Pilot", systemId: JITA, state: "space" }] });
  const adapter = { shipAiSeams: () => ({ ok: true, seam: { identities: {
    corporationExists: () => ({ ok: true, exists: true }), writeCharacter: () => ({ ok: true }),
    flush: () => ({ ok: true }) }, xmpp: {}, channel: () => null } }),
  installChatCommand: () => ({ ok: true }), uninstallChatCommand: () => ({ ok: true }), readPresence: presence,
  sendCharacterSystemLine: (spec) => {
    system.push(spec);
    return { ok: true };
  }, readStaticMap: () => ({ ok: false, reason: "TEST" }) };
  const config = { ...base, observer: { ...base.observer, enabled: true, port: 26410 },
    inGameMap: { ...(base.inGameMap || {}), observerUrl: "" },
    shipAi: { ...base.shipAi, channel: "local", allowCharacterIds: "*", apiKey: KEY, minIntervalMs: 0,
      toolMode: "off", memoryEnabled: false, proactiveEnabled: false, mailEnabled: false, portraitEnabled: false,
      ...(opts.shipAi || {}) } };
  const clock = mutableClock();
  const transport = deferredTransport();
  const started = startShipAi({ config, persistence, adapter, transport, clock, httpRoutes,
    randomBytes: counterBytes(), logger: { log: (l) => logs.push(String(l)) },
    setTimer: () => ({ cancel() {}, hasRef: () => false }),
    telemetry: { count: (n, v) => metrics.push(`${n}=${v}`), observe: () => {} } });
  assert.strictEqual(started.ok, true, JSON.stringify(started));
  return { ai: started.shipAi, logs, metrics, system, httpRoutes, clock, transport,
    say: (text, id = PLAYER) => started.shipAi.handle({ characterId: id, name: "Pilot One", systemId: JITA }, text,
      XMPP) };
}

module.exports = ({ test, skip }) => {
  test("V1 toSpeechText / splitSentences: links, URLs and emoji off, a link line -> null, cut at a sentence, 1.5 / 1,5 "
    + "never split", () => {
    assert.strictEqual(toSpeechText("Hello <a href=\"http://x/y\">click</a> captain. See https://foo.bar/x now \u{1F680}!",
      { maxChars: 400 }), "Hello captain. See now!");
    assert.strictEqual(toSpeechText("<a href=\"http://127.0.0.1:26410/shipai-voice.html#t=abc\">Ship AI voice</a>",
      { maxChars: 400 }), null);
    assert.strictEqual(toSpeechText("https://example.org/a \u{1F600}\u{FE0F}", { maxChars: 400 }), null);
    assert.strictEqual(toSpeechText("a\u0007b <b>bold</b> &amp; more", { maxChars: 400 }), "a b bold & more");
    const long = "First sentence here. Second sentence is a bit longer. Third one.";
    assert.strictEqual(toSpeechText(long, { maxChars: 40 }), "First sentence here.");
    assert.ok(toSpeechText("word ".repeat(30), { maxChars: 42 }).length <= 42);
    assert.deepStrictEqual(splitSentences("Speed 1.5 AU and 1,5 km. Done! Really?", 200),
      ["Speed 1.5 AU and 1,5 km.", "Done!", "Really?"]);
    const parts = splitSentences(`${"alpha ".repeat(20)}end.`, 40);
    assert.ok(parts.length > 1 && parts.every((p) => p.length <= 40), JSON.stringify(parts));
    assert.deepStrictEqual([langTagOf("pl"), langTagOf("en"), langTagOf("de")], ["pl-PL", "en-US", "en-US"]);
  });

  test("V2 queue: no listener -> NO_LISTENER and nothing kept; take twice = same lines; cap / TTL drop the oldest; a "
    + "second session -> SUPERSEDED; no poll past voiceListenerIdleMs -> NO_LISTENER", () => {
    const clock = mutableClock();
    const QS = { ...V, voiceQueueMax: 2, voiceListenerIdleMs: V.voiceLineTtlMs * 2 };
    const q = createVoiceQueue({ S: QS, nowMs: clock.now, randomBytes: counterBytes() });
    assert.deepStrictEqual(q.push(PLAYER, ["hi"], "en-US"), { ok: false, reason: "NO_LISTENER" });
    assert.strictEqual(q.status().buffered, 0);
    assert.deepStrictEqual(q.attach(PLAYER, "sidA"), { ok: true, superseded: false });
    assert.deepStrictEqual(q.push(PLAYER, [], "en-US"), { ok: false, reason: "EMPTY" });
    assert.strictEqual(q.push(PLAYER, ["one"], "en-US").ok, true);
    const first = q.take(PLAYER, "sidA", 0);
    const again = q.take(PLAYER, "sidA", 0);
    assert.deepStrictEqual(first.lines.map((l) => l.parts), [["one"]]);
    assert.deepStrictEqual(again, first, "a take never removes a line");
    q.push(PLAYER, ["two"], "en-US");
    q.push(PLAYER, ["three"], "en-US");
    assert.deepStrictEqual(q.take(PLAYER, "sidA", 0).lines.map((l) => l.parts[0]), ["two", "three"], "cap 2");
    clock.advance(V.voiceLineTtlMs + 1);
    assert.deepStrictEqual(q.take(PLAYER, "sidA", 0).lines, [], "TTL");
    assert.strictEqual(q.status().dropped, 3, "1 over the cap + 2 past the TTL");
    assert.deepStrictEqual(q.attach(PLAYER, "sidB"), { ok: true, superseded: true });
    assert.deepStrictEqual(q.take(PLAYER, "sidA", 0), { ok: false, reason: "SUPERSEDED" });
    assert.strictEqual(q.take(PLAYER, "sidB", 0).ok, true);
    clock.advance(QS.voiceListenerIdleMs + 1);
    assert.deepStrictEqual(q.push(PLAYER, ["late"], "en-US"), { ok: false, reason: "NO_LISTENER" });
    assert.strictEqual(q.listening(PLAYER), false);
    assert.deepStrictEqual(q.status().listeners, 0);
  });

  test("V3 routes: Origin 403, bad token 401, lines without the header 401, the lines of A not seen by B, no-store, "
    + "no line text in the log", () => {
    const clock = mutableClock();
    const logs = [];
    const sessions = createSessions({ linkTtlMs: V.voiceLinkTtlMs, sessionTtlMs: V.voiceSessionTtlMs,
      maxSessions: V.voiceMaxSessions, clock, randomBytes: counterBytes() });
    const queue = createVoiceQueue({ S: V, nowMs: clock.now, randomBytes: counterBytes() });
    const route = createVoiceRoutes({ sessions, queue, log: (l) => logs.push(l),
      settingsOf: () => ({ aiName: "Jin", lang: "en-US", settings: { pollMs: 1500 } }) });
    const tokenA = sessions.issueToken({ characterId: PLAYER, characterName: "Pilot One" }).token;
    const tokenB = sessions.issueToken({ characterId: OTHER, characterName: "Rival Pilot" }).token;
    const post = (p, body, headers) => call(route, "POST", `/api/shipai/${p}`, { body, headers: { origin: ORIGIN,
      ...(headers || {}) } });
    assert.deepStrictEqual([post("session", { token: tokenA }, { origin: "http://evil.example" }).status,
      post("session", { token: "x".repeat(43) }).status, post("session", "not json").status], [403, 401, 400]);
    const a = post("session", { token: tokenA });
    assert.strictEqual(a.status, 200, a.body);
    assert.strictEqual(a.headers["Cache-Control"], "no-store");
    const sidA = a.json().sid;
    assert.deepStrictEqual([a.json().aiName, a.json().lang], ["Jin", "en-US"]);
    const sidB = post("session", { token: tokenB }).json().sid;
    queue.push(PLAYER, [SECRET_LINE], "en-US");
    const noHeader = call(route, "GET", "/api/shipai/lines?after=0");
    assert.deepStrictEqual([noHeader.status, noHeader.json().reason], [401, "NO_SESSION"]);
    const get = (sid, after = "0") => call(route, "GET", `/api/shipai/lines?after=${after}`,
      { headers: { "x-lne-voice": sid } });
    const la = get(sidA);
    assert.strictEqual(la.status, 200, la.body);
    assert.deepStrictEqual(la.json().lines.map((l) => l.parts), [[SECRET_LINE]]);
    assert.strictEqual(la.headers["Cache-Control"], "no-store");
    assert.deepStrictEqual(get(sidB).json().lines, [], "B never sees the lines of A");
    assert.strictEqual(get(sidA, "x").status, 400);
    assert.deepStrictEqual([call(route, "GET", "/api/shipai/nope").status, call(route, "GET", "/api/shipai/session")
      .status], [404, 405]);
    assert.strictEqual(post("logout", undefined, { "x-lne-voice": sidA }).status, 200);
    assert.strictEqual(get(sidA).status, 401, "logout ends the session");
    assert.ok(logs.length > 0 && logs.every((l) => !l.includes("Raven") && !l.includes(String(PLAYER))
      && !l.includes(sidA)), JSON.stringify(logs));
  });

  const driver = SH.loadDriver();
  const v4 = "V4 startShipAi: voice off = no route, VOICE_OFF, nothing buffered; voice on = route, a model reply in "
    + "the buffer of the listener, no extra model request, the room reply of !ai voice not buffered, stop unregisters";
  if (!driver.ok) skip(v4, `better-sqlite3 unavailable (${driver.detail})`);
  else {
    test(v4, () => SH.withStoreAsync(driver, async (persistence) => {
      insertPrefs(persistence.store, PLAYER, AI);
      insertPrefs(persistence.store, OTHER, AI2);
      const off = service(persistence);
      assert.ok(!off.httpRoutes.list().includes("/api/shipai/"));
      assert.ok(off.say("!ai voice").includes("VOICE_OFF"));
      off.say("!ai hello");
      off.transport.calls[0].resolve(completion("Shields holding."));
      await flush();
      assert.strictEqual(off.system.length, 1, "the reply is delivered");
      assert.deepStrictEqual(off.ai.getStatus().voice, { state: "off" });
      assert.ok(!off.metrics.some((m) => m.startsWith("shipAi.voice")));
      off.ai.stop("test");

      const on = service(persistence, { shipAi: { voiceEnabled: true } });
      assert.deepStrictEqual(on.httpRoutes.list(), ["/api/shipai/"]);
      const reply = on.say("!ai voice");
      const m = /<a href="http:\/\/127\.0\.0\.1:26410\/shipai-voice\.html#t=([A-Za-z0-9_-]{43})">/.exec(reply);
      assert.ok(m, reply);
      assert.ok(on.say("!ai voice").includes("RATE_LIMITED"), "voiceLinkCooldownMs");
      const route = on.httpRoutes.match("/api/shipai/session");
      const opened = call(route, "POST", "/api/shipai/session", { body: { token: m[1] }, headers: { origin: ORIGIN } });
      assert.strictEqual(opened.status, 200, opened.body);
      const sid = opened.json().sid;
      assert.strictEqual(opened.json().settings.engine, "browser");
      on.say(`!ai ${"x"}`);
      assert.strictEqual(on.transport.calls.length, 1);
      on.transport.calls[0].resolve(completion(SECRET_LINE));
      await flush();
      const lines = () => call(route, "GET", "/api/shipai/lines?after=0", { headers: { "x-lne-voice": sid } }).json();
      assert.deepStrictEqual(lines().lines.map((l) => l.parts.join(" ")), [SECRET_LINE]);
      on.ai.onRoomMessage(PLAYER, "!ai voice status");
      const statusLine = on.system[on.system.length - 1].text;
      assert.ok(statusLine.includes("reading my lines"), statusLine);
      assert.strictEqual(lines().lines.length, 1, "the room reply of !ai voice is never buffered");
      assert.strictEqual(on.transport.calls.length, 1, "the voice made no model request");
      assert.ok(on.metrics.includes("shipAi.voiceLines=1") && on.metrics.includes("shipAi.voiceSessions=1"));
      const st = on.ai.getStatus().voice;
      assert.deepStrictEqual([st.state, st.lines, st.sessionsOpened, st.links], ["running", 1, 1, 1]);
      assert.ok(!JSON.stringify(st).includes("Raven") && !JSON.stringify(st).includes(String(PLAYER)));
      for (const l of on.logs) assert.ok(!l.includes("Raven") && !l.includes(m[1]) && !l.includes(sid), l);
      assert.ok(on.ai.handle({ characterId: PLAYER, systemId: JITA }, "!ai voice off", XMPP).includes("voice off"));
      on.ai.stop("test");
      assert.deepStrictEqual(on.httpRoutes.list(), []);
    }));
  }

  test("V5 static: ASSET_FILES has the page and its script; the script has no innerHTML / eval / new Function / "
    + "absolute URL; the voice rows of SCHEMA with the expected defaults", () => {
    const routes = ASSET_FILES.map((a) => a.route);
    for (const r of ["/shipai-voice.html", "/shipaiVoice.js"]) assert.ok(routes.includes(r), r);
    const script = fs.readFileSync(path.join(MOD_DIR, "web", "shipaiVoice.js"), "utf8");
    for (const bad of ["innerHTML", "eval(", "new Function", "http://", "https://"]) {
      assert.ok(!script.includes(bad), `shipaiVoice.js contains ${bad}`);
    }
    const html = fs.readFileSync(path.join(MOD_DIR, "web", "shipai-voice.html"), "utf8");
    assert.ok(!/<script>|<style|\son[a-z]+=/i.test(html), "no inline script / style / handler");
    const want = { voiceEnabled: false, voiceEngine: "browser", voiceLinkTtlMs: 600000, voiceLinkCooldownMs: 10000,
      voiceSessionTtlMs: 14400000, voiceMaxSessions: 4, voicePollMs: 1500, voiceListenerIdleMs: 15000,
      voiceQueueMax: 6, voiceLineTtlMs: 120000, voiceMaxLineChars: 400, voiceMaxPartChars: 200, voiceRateMilli: 1000,
      voicePitchMilli: 1100, voiceName: "", voiceAllowRemote: false, voiceShowText: true };
    const sub1 = (key) => Object.prototype.hasOwnProperty.call(want, key);
    const got = Object.fromEntries(SCHEMA.filter((r) => /^shipAi\.voice/.test(r.key))
      .map((r) => [r.key.slice("shipAi.".length), r.default]).filter(([k]) => sub1(k)));
    assert.deepStrictEqual(got, want);
    assert.deepStrictEqual(Object.fromEntries(Object.entries(V).filter(([k]) => sub1(k))),
      { ...want, voiceEngine: "browser" });
    assert.ok(S.METRICS.includes("shipAi.voiceLines") && S.METRICS.includes("shipAi.voiceSessions"));
  });
};
