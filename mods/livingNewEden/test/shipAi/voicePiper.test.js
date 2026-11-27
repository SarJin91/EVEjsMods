"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { resolveConfig, SCHEMA } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { parsePiperUrl, createPiperTransport } = require("../../lib/shipAi/voice/piperTransport");
const { createAudioCache } = require("../../lib/shipAi/voice/audioCache");
const { createPiperEngine } = require("../../lib/shipAi/voice/piperEngine");
const { createVoiceQueue } = require("../../lib/shipAi/voice/queue");
const { createShipAiVoice } = require("../../lib/shipAi/voice");
const { createHttpRoutes } = require("../../lib/observer/httpRoutes");
const { createLocks, LNE_LOCKS } = require("../../lib/modSettings/locks");
const { findCompose } = require("../config/composeKeys.test.js");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_DIR = path.resolve(MOD_DIR, "..", "..");
const PLAYER = 9001;
const OTHER = 9002;
const T0 = 1700000000000;
const ORIGIN = "http://127.0.0.1:26410";
const SECRET_LINE = "Kapitanie, ladownia Pilota One ma 3 blueprinty Raven.";

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
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const wav = (fill = 1, size = 32) => {
  const b = Buffer.alloc(size, fill);
  b.write("RIFF", 0, "latin1");
  b.write("WAVE", 8, "latin1");
  return b;
};
const noTimeout = () => new AbortController().signal;

function fakeRequest() {
  const calls = [];
  const request = (url, opts, cb) => {
    const req = new EventEmitter();
    const call = { url, opts, body: null, destroyed: false, req, cb };
    req.end = (payload) => { call.body = JSON.parse(Buffer.from(payload).toString("utf8")); };
    req.destroy = () => { call.destroyed = true; };
    calls.push(call);
    return req;
  };
  const answer = (i, { status = 200, chunks = [wav()], headers = {} } = {}) => {
    const res = new EventEmitter();
    res.statusCode = status;
    res.headers = headers;
    res.resume = () => {};
    calls[i].cb(res);
    for (const c of chunks) res.emit("data", c);
    res.emit("end");
  };
  return { calls, request, answer };
}

function deferredTransport() {
  const calls = [];
  return { calls, post(url, json, opts) {
    return new Promise((resolve) => calls.push({ url, json, opts, resolve }));
  } };
}

function fakeRes() {
  return { status: 0, headers: null, raw: null, writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }, end(body) {
    this.raw = body === undefined ? null : body;
  }, json() {
    return JSON.parse(String(this.raw));
  } };
}

function call(route, method, url, opts = {}) {
  const res = fakeRes();
  route.handle({ method, url, headers: opts.headers || {} }, res, opts.body === undefined ? null
    : Buffer.from(JSON.stringify(opts.body)));
  return res;
}

module.exports = ({ test }) => {
  test("PT1 parsePiperUrl (http ok; user:pass / ftp / query / hash -> PIPER_URL_INVALID) and the transport (200 RIFF "
    + "-> bytes, TIMEOUT, TOO_LARGE destroys the stream, HTTP_500)", async () => {
    const ok = parsePiperUrl("http://piper:5000");
    assert.deepStrictEqual([ok.ok, ok.synthesizeUrl.href], [true, "http://piper:5000/synthesize"]);
    assert.strictEqual(parsePiperUrl("http://127.0.0.1:5000/tts").synthesizeUrl.href,
      "http://127.0.0.1:5000/tts/synthesize");
    for (const bad of ["http://user:pass@piper:5000", "ftp://piper:5000", "http://piper:5000/?x=1",
      "http://piper:5000/#a", "", "piper:5000 "]) {
      assert.deepStrictEqual(parsePiperUrl(bad), { ok: false, reason: "PIPER_URL_INVALID" }, bad);
    }
    const url = ok.synthesizeUrl;
    const body = { text: "Witaj", voice: "pl_PL-gosia-medium", length_scale: 1 };
    const opts = { timeoutMs: 15000, maxBytes: 64 };

    const f = fakeRequest();
    const t = createPiperTransport({ request: f.request, timeoutSignal: noTimeout });
    const p1 = t.post(url, body, opts);
    assert.deepStrictEqual([f.calls[0].opts.method, f.calls[0].body], ["POST", body]);
    f.answer(0, { chunks: [wav(1, 20), Buffer.alloc(12, 2)] });
    const r1 = await p1;
    assert.deepStrictEqual([r1.ok, r1.status, r1.bytes.length, r1.bytes.toString("latin1", 0, 4)],
      [true, 200, 32, "RIFF"]);

    const ac = new AbortController();
    const t2 = createPiperTransport({ request: f.request, timeoutSignal: () => ac.signal });
    const p2 = t2.post(url, body, opts);
    ac.abort();
    assert.deepStrictEqual(await p2, { ok: false, reason: "TIMEOUT" });
    assert.strictEqual(f.calls[1].destroyed, true);

    const p3 = t.post(url, body, opts);
    f.answer(2, { chunks: [wav(1, 40), Buffer.alloc(40, 3)] });
    assert.deepStrictEqual(await p3, { ok: false, reason: "TOO_LARGE" });
    assert.strictEqual(f.calls[2].destroyed, true, "the stream is destroyed past maxBytes");

    const p4 = t.post(url, body, opts);
    f.answer(3, { status: 500, chunks: [] });
    assert.deepStrictEqual(await p4, { ok: false, reason: "HTTP_500" });
  });

  test("PT2 engine: maxInFlight 1, the overflow DROPPED, 3 failures -> BREAKER, the char budget -> BUDGET, a cache hit "
    + "= 0 requests, the LRU stays <= maxBytes", async () => {
    const clock = mutableClock();
    const ES = { ...V, voicePiperMaxInFlight: 1, voiceQueueMax: 1, voiceBreakerFailures: 3 };
    const tr = deferredTransport();
    const cache = createAudioCache({ maxBytes: 4096, nowMs: clock.now, randomBytes: counterBytes() });
    const url = parsePiperUrl("http://piper:5000").synthesizeUrl;
    const e = createPiperEngine({ S: ES, transport: tr, cache, url, nowMs: clock.now });
    const a = e.synthesize(PLAYER, "Pierwsza linia.", "pl-PL");
    const b = e.synthesize(PLAYER, "Druga linia.", "pl-PL");
    assert.deepStrictEqual(await e.synthesize(PLAYER, "Trzecia linia.", "pl-PL"), { ok: false, reason: "DROPPED" });
    assert.strictEqual(tr.calls.length, 1, "the second request waits for the first");
    assert.deepStrictEqual(tr.calls[0].json, { text: "Pierwsza linia.", voice: "pl_PL-gosia-medium", length_scale: 1 });
    tr.calls[0].resolve({ ok: true, status: 200, bytes: wav() });
    const ra = await a;
    assert.deepStrictEqual([ra.ok, ra.cached], [true, false]);
    await flush();
    assert.strictEqual(tr.calls.length, 2, "the second starts after the first");
    tr.calls[1].resolve({ ok: false, reason: "HTTP_500" });
    assert.deepStrictEqual(await b, { ok: false, reason: "HTTP_500" });

    const hit = await e.synthesize(OTHER, "Pierwsza linia.", "pl-PL");
    assert.deepStrictEqual([hit.ok, hit.cached, hit.audioId, tr.calls.length], [true, true, ra.audioId, 2]);
    assert.ok(cache.byId(ra.audioId, OTHER), "a hit adds the asking character as an owner");
    assert.deepStrictEqual(await e.synthesize(PLAYER, "Hello.", "en-US"), { ok: false, reason: "NO_VOICE" });

    const c = e.synthesize(PLAYER, "Czwarta.", "pl-PL");
    tr.calls[2].resolve({ ok: true, status: 200, bytes: Buffer.from("not a wave file at all") });
    assert.deepStrictEqual(await c, { ok: false, reason: "BAD_AUDIO" });
    const d = e.synthesize(PLAYER, "Piata.", "pl-PL");
    tr.calls[3].resolve({ ok: false, reason: "NET_ERROR" });
    assert.deepStrictEqual(await d, { ok: false, reason: "NET_ERROR" });
    assert.deepStrictEqual(await e.synthesize(PLAYER, "Szosta.", "pl-PL"), { ok: false, reason: "BREAKER" });
    assert.strictEqual(tr.calls.length, 4, "an open breaker sends nothing");
    const st = e.status();
    assert.deepStrictEqual([st.breakerOpen, st.cacheHits, st.synth, st.dropped, st.failed_BAD_AUDIO],
      [true, 1, 1, 1, 1]);
    clock.advance(ES.voiceBreakerCooldownMs);
    const probe = e.synthesize(PLAYER, "Siodma.", "pl-PL");
    assert.strictEqual(tr.calls.length, 5, "after the cooldown one probe goes");
    tr.calls[4].resolve({ ok: true, status: 200, bytes: wav(2) });
    assert.strictEqual((await probe).ok, true);
    e.stop();
    assert.deepStrictEqual(await e.synthesize(PLAYER, "Po stopie.", "pl-PL"), { ok: false, reason: "STOPPED" });

    const small = createPiperEngine({ S: { ...ES, voiceDailyChars: 10 }, transport: tr, url, nowMs: clock.now,
      cache: createAudioCache({ maxBytes: 4096, nowMs: clock.now, randomBytes: counterBytes() }) });
    small.synthesize(PLAYER, "Krotko.", "pl-PL");
    assert.deepStrictEqual(await small.synthesize(PLAYER, "Za dluga linia.", "pl-PL"), { ok: false, reason: "BUDGET" });
    const zero = createPiperEngine({ S: { ...ES, voiceDailyChars: 0 }, transport: tr, url, nowMs: clock.now,
      cache: createAudioCache({ maxBytes: 4096, nowMs: clock.now, randomBytes: counterBytes() }) });
    assert.deepStrictEqual(await zero.synthesize(PLAYER, "A.", "pl-PL"), { ok: false, reason: "BUDGET" });

    const lru = createAudioCache({ maxBytes: 100, nowMs: clock.now, randomBytes: counterBytes() });
    const ids = ["k1", "k2", "k3"].map((k) => lru.put(k, Buffer.alloc(40, 1), PLAYER).id);
    assert.ok(lru.stats().bytes <= 100, JSON.stringify(lru.stats()));
    assert.deepStrictEqual([lru.byId(ids[0], PLAYER), lru.get("k1")], [null, null], "the oldest went");
    assert.ok(Buffer.isBuffer(lru.byId(ids[2], PLAYER)));
    assert.strictEqual(lru.byId(ids[2], OTHER), null, "only an owner");
  });

  test("PT3 queue order: a PENDING line holds the later READY one; after its audio both go in seq order; past "
    + "voicePiperTimeoutMs + voicePollMs a PENDING line goes without audioId", () => {
    const clock = mutableClock();
    const q = createVoiceQueue({ S: { ...V, voiceListenerIdleMs: 120000, voiceLineTtlMs: 600000 }, nowMs: clock.now,
      randomBytes: counterBytes() });
    q.attach(PLAYER, "sidA");
    const s1 = q.push(PLAYER, ["Jeden."], "pl-PL", { pending: true }).seq;
    const s2 = q.push(PLAYER, ["Dwa."], "pl-PL", { pending: true }).seq;
    assert.strictEqual(q.resolve(PLAYER, s2, "B".repeat(22)), true);
    assert.deepStrictEqual(q.take(PLAYER, "sidA", 0).lines, [], "line 1 is PENDING: nothing goes");
    q.resolve(PLAYER, s1, "A".repeat(22));
    const both = q.take(PLAYER, "sidA", 0);
    assert.deepStrictEqual(both.lines.map((l) => [l.seq, l.audioId]), [[s1, "A".repeat(22)], [s2, "B".repeat(22)]]);
    const s3 = q.push(PLAYER, ["Trzy."], "pl-PL", { pending: true }).seq;
    clock.advance(V.voicePiperTimeoutMs);
    assert.deepStrictEqual(q.take(PLAYER, "sidA", s2).lines, [], "still within the wait");
    clock.advance(V.voicePollMs + 1);
    const late = q.take(PLAYER, "sidA", s2);
    assert.deepStrictEqual(late.lines, [{ seq: s3, parts: ["Trzy."], lang: "pl-PL" }], "no audioId after the wait");
    assert.strictEqual(q.resolve(PLAYER, s3, "C".repeat(22)), false, "a late audio changes nothing");
    assert.strictEqual(q.status().pendingExpired, 1);
  });

  test("PT4 audio route and engine choice: owner 200 audio/wav no-store, another session / unknown id 404; browser "
    + "and piper without URL = 0 Piper requests; no line text in logs or status; off revokes a link "
    + "a superseded session ends (409)", async () => {
    const make = (over, f) => {
      const clock = mutableClock();
      const logs = [];
      const httpRoutes = createHttpRoutes();
      const started = createShipAiVoice({ S: Object.freeze({ ...V, voiceEnabled: true, language: "pl", ...over }),
        nowMs: clock.now, randomBytes: counterBytes(), httpRoutes,
        observerUrl: () => ({ ok: true, url: `${ORIGIN}/` }), logger: { log: (l) => logs.push(String(l)) },
        telemetry: { count: () => {}, observe: () => {} }, aiNameOf: () => "Jin", piperRequest: f.request,
        piperTimeoutSignal: noTimeout });
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      const route = httpRoutes.match("/api/shipai/session");
      const open = (playerId) => {
        const token = /#t=([A-Za-z0-9_-]{43})$/.exec(started.voice.link(playerId, "P").href)[1];
        clock.advance(V.voiceLinkCooldownMs);
        return call(route, "POST", "/api/shipai/session", { body: { token }, headers: { origin: ORIGIN } });
      };
      const lines = (sid) => call(route, "GET", "/api/shipai/lines?after=0", { headers: { "x-lne-voice": sid } });
      return { voice: started.voice, route, open, lines, logs, clock };
    };

    const f = fakeRequest();
    const p = make({ voiceEngine: "piper", voicePiperUrl: "http://piper:5000" }, f);
    const a = p.open(PLAYER);
    assert.strictEqual(a.json().settings.engine, "piper");
    assert.deepStrictEqual([a.json().settings.radioFilter, a.json().settings.fallbackBrowser], [true, true]);
    const sidA = a.json().sid;
    const sidB = p.open(OTHER).json().sid;
    p.voice.onDelivered(PLAYER, [SECRET_LINE]);
    assert.strictEqual(f.calls.length, 1);
    assert.deepStrictEqual([f.calls[0].url.href, f.calls[0].body.text], ["http://piper:5000/synthesize", SECRET_LINE]);
    assert.deepStrictEqual(p.lines(sidA).json().lines, [], "PENDING until the audio");
    const audio = wav(7, 64);
    f.answer(0, { chunks: [audio] });
    await flush();
    const got = p.lines(sidA).json().lines;
    assert.strictEqual(got.length, 1);
    const id = got[0].audioId;
    assert.ok(/^[A-Za-z0-9_-]{22}$/.test(id), id);
    const ok = call(p.route, "GET", `/api/shipai/audio/${id}`, { headers: { "x-lne-voice": sidA } });
    assert.deepStrictEqual([ok.status, ok.headers["Content-Type"], ok.headers["Cache-Control"]],
      [200, "audio/wav", "no-store"]);
    assert.ok(Buffer.isBuffer(ok.raw) && ok.raw.equals(audio));
    assert.strictEqual(call(p.route, "GET", `/api/shipai/audio/${id}`, { headers: { "x-lne-voice": sidB } }).status,
      404, "another session");
    assert.strictEqual(call(p.route, "GET", `/api/shipai/audio/${"Z".repeat(22)}`,
      { headers: { "x-lne-voice": sidA } }).status, 404, "unknown id");
    assert.strictEqual(call(p.route, "POST", `/api/shipai/audio/${id}`, { headers: { "x-lne-voice": sidA } }).status,
      405);
    p.voice.onDelivered(PLAYER, [SECRET_LINE]);
    assert.strictEqual(f.calls.length, 1, "the same line again = a cache hit");
    await flush();
    const st = p.voice.getStatus();
    assert.deepStrictEqual([st.engineStatus, st.withAudio, st.piper.cacheHits, st.piper.synth], ["running", 2, 1, 1]);
    for (const text of [JSON.stringify(st), ...p.logs]) {
      assert.ok(!text.includes("Raven") && !text.includes(String(PLAYER)) && !text.includes(sidA), text);
    }

    const a2 = p.open(PLAYER).json().sid;
    assert.deepStrictEqual([p.lines(sidA).status, p.lines(sidA).json().reason], [409, "SUPERSEDED"]);
    assert.strictEqual(p.lines(a2).status, 200);
    const token = /#t=([A-Za-z0-9_-]{43})$/.exec(p.voice.link(PLAYER, "P").href)[1];
    p.voice.off(PLAYER);
    assert.strictEqual(call(p.route, "POST", "/api/shipai/session", { body: { token },
      headers: { origin: ORIGIN } }).status, 401);
    p.voice.stop();

    for (const over of [{ voiceEngine: "browser", voicePiperUrl: "http://piper:5000" },
      { voiceEngine: "piper", voicePiperUrl: "" }]) {
      const spy = fakeRequest();
      const b = make(over, spy);
      const s = b.open(PLAYER).json();
      assert.strictEqual(s.settings.engine, "browser");
      b.voice.onDelivered(PLAYER, [SECRET_LINE]);
      await flush();
      assert.strictEqual(spy.calls.length, 0, JSON.stringify(over));
      assert.deepStrictEqual(b.lines(s.sid).json().lines.map((l) => [l.parts.join(" "), l.audioId]),
        [[SECRET_LINE, undefined]]);
      assert.strictEqual(b.voice.getStatus().engineStatus, over.voiceEngine === "piper" ? "PIPER_URL_MISSING"
        : undefined);
      b.voice.stop();
    }
  });

  test("PT5 static: compose service piper (profiles tts, no ports), the server env VOICE_PIPER_URL; voices.txt pins "
    + "+ licence; Dockerfile pins; CREDITS Piper GPL-3.0 + each voice; SCHEMA defaults; voicePiperUrl locked", () => {
    const file = findCompose();
    if (file) {
      const text = fs.readFileSync(file, "utf8");
      const m = /\n  piper:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]*:\n|\n[a-z])/.exec(text);
      assert.ok(m, "service piper in compose.yaml");
      const block = m[1];
      assert.ok(/^\s+profiles: \["tts"\]$/m.test(block), block);
      assert.ok(!/^\s+ports:/m.test(block), "no host port");
      assert.ok(/^\s+expose:/m.test(block) && block.includes("./docker/piper"), block);
      assert.ok(!block.includes("--debug"));
      assert.ok(text.includes("EVEJS_LNE_SHIP_AI_VOICE_PIPER_URL: ${EVEJS_LNE_SHIP_AI_VOICE_PIPER_URL:-}"));
      assert.ok(/^\s+networks:\n\s+- tts$/m.test(block) && !/default/.test(block), block);
      assert.ok(/\n  tts:\n    internal: true\n/.test(text.slice(text.indexOf("\nnetworks:"))), "networks.tts internal");
      const users = [...text.matchAll(/\n  ([a-z][a-z0-9-]*):\n[\s\S]*?(?=\n  [a-z][a-z0-9-]*:\n|\n[a-z])/g)]
        .filter((s) => /^\s+(- tts|tts: \{\})$/m.test(s[0])).map((s) => s[1]).sort();
      assert.deepStrictEqual(users, ["piper", "server"]);
    }
    const piperDir = path.join(REPO_DIR, "docker", "piper");
    const voices = fs.readFileSync(path.join(piperDir, "voices.txt"), "utf8").split(/\r?\n/)
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).map((l) => l.split("|").map((x) => x.trim()));
    assert.ok(voices.length >= 1);
    for (const [name, rev, sha1, sha2, licence] of voices) {
      assert.ok(/^[a-z]{2,3}_[A-Z]{2}-[A-Za-z0-9_]+-(x_low|low|medium|high)$/.test(name), name);
      assert.ok(/^[0-9a-f]{40}$/.test(rev) && /^[0-9a-f]{64}$/.test(sha1) && /^[0-9a-f]{64}$/.test(sha2), name);
      assert.ok(/CC0|CC-BY|Apache-2\.0/.test(licence), `${name}: ${licence}`);
    }
    assert.ok(voices.some(([name]) => name === V.voicePiperVoicePl), "the default pl voice is baked");
    const docker = fs.readFileSync(path.join(piperDir, "Dockerfile"), "utf8");
    assert.ok(/^FROM [^\s]+@sha256:[0-9a-f]{64}$/m.test(docker) && /"piper-tts\[http\]==\d+\.\d+\.\d+"/.test(docker));
    const credits = fs.readFileSync(path.join(MOD_DIR, "CREDITS.md"), "utf8");
    assert.ok(/Piper[^\n]*GPL-3\.0/.test(credits) && credits.includes("Separate process"));
    for (const [name, , , , licence] of voices) {
      assert.ok(credits.includes(name) && credits.includes(licence.split(" ")[0].replace("-1.0", "")), name);
    }
    const want = { voicePiperUrl: "", voicePiperVoicePl: "pl_PL-gosia-medium", voicePiperVoiceEn: "",
      voicePiperTimeoutMs: 15000, voicePiperMaxBytes: 2097152, voicePiperMaxInFlight: 1, voiceLengthScaleMilli: 1000,
      voiceCacheMaxBytes: 8388608, voiceDailyChars: 300000, voiceBreakerFailures: 3, voiceBreakerCooldownMs: 60000,
      voiceRadioFilter: true, voiceFallbackBrowser: true };
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, (SCHEMA.find((r) => r.key === `shipAi.${k}`)
      || {}).default]));
    assert.deepStrictEqual(got, want);
    assert.deepStrictEqual(Object.fromEntries(Object.keys(want).map((k) => [k, V[k]])), want);
    for (const m of ["shipAi.voiceSynth", "shipAi.voiceSynthMs", "shipAi.voiceFailed"]) assert.ok(S.METRICS.includes(m));
    const row = SCHEMA.find((r) => r.key === "shipAi.voicePiperUrl");
    assert.deepStrictEqual(createLocks(LNE_LOCKS).locked(row), { locked: true, reason: "SECRET" });
  });

  test("PT6: a waiting job nobody wants is UNWANTED without a request; waiting jobs reserve their "
    + "characters at admission; the queue answers awaitsAudio", async () => {
    const clock = mutableClock();
    const ES = { ...V, voicePiperMaxInFlight: 1, voiceQueueMax: 4, voiceDailyChars: 20 };
    const tr = deferredTransport();
    const url = parsePiperUrl("http://piper:5000").synthesizeUrl;
    const e = createPiperEngine({ S: ES, transport: tr, url, nowMs: clock.now,
      cache: createAudioCache({ maxBytes: 4096, nowMs: clock.now, randomBytes: counterBytes() }) });
    let wantB = true;
    const a = e.synthesize(PLAYER, "Jeden.", "pl-PL");
    const b = e.synthesize(PLAYER, "Dwa dwa.", "pl-PL", { wanted: () => wantB });
    assert.deepStrictEqual([e.status().charsToday, e.status().charsReserved], [6, 8]);
    assert.deepStrictEqual(await e.synthesize(PLAYER, "Trzy tr.", "pl-PL"), { ok: false, reason: "BUDGET" });
    const c = e.synthesize(PLAYER, "Cztery", "pl-PL", { wanted: () => true });
    wantB = false;
    tr.calls[0].resolve({ ok: true, status: 200, bytes: wav() });
    assert.strictEqual((await a).ok, true);
    assert.deepStrictEqual(await b, { ok: false, reason: "UNWANTED" });
    await flush();
    assert.deepStrictEqual(tr.calls.map((x) => x.json.text), ["Jeden.", "Cztery"], "b sent nothing");
    const st = e.status();
    assert.deepStrictEqual([st.unwanted, st.charsToday, st.charsReserved], [1, 12, 0], "b gave its characters back");
    tr.calls[1].resolve({ ok: true, status: 200, bytes: wav(3) });
    assert.strictEqual((await c).ok, true);
    e.stop();

    const q = createVoiceQueue({ S: { ...V, voiceListenerIdleMs: 120000, voiceLineTtlMs: 600000 }, nowMs: clock.now,
      randomBytes: counterBytes() });
    q.attach(PLAYER, "sidA");
    const s1 = q.push(PLAYER, ["Jeden."], "pl-PL", { pending: true }).seq;
    assert.strictEqual(q.awaitsAudio(PLAYER, s1), true);
    clock.advance(V.voicePiperTimeoutMs + V.voicePollMs + 1);
    assert.strictEqual(q.awaitsAudio(PLAYER, s1), false, "past the wait the line goes without audio");
    const s2 = q.push(PLAYER, ["Dwa."], "pl-PL", { pending: true }).seq;
    q.detach(PLAYER);
    assert.strictEqual(q.awaitsAudio(PLAYER, s2), false, "!ai voice off");
  });
};
