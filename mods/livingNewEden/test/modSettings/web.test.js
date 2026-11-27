"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const { resolveConfig } = require("../../config");
const { createViewRegistry } = require("../../lib/observer/views");
const { createHttpRoutes } = require("../../lib/observer/httpRoutes");
const { BASE_HEADERS } = require("../../lib/observer/router");
const { startObserver } = require("../../lib/observer");
const { createSessions } = require("../../lib/modSettings/web/sessions");
const { createSettingsRoutes } = require("../../lib/modSettings/web/routes");
const { startModSettings } = require("../../lib/modSettings");
const { auditPathOf } = require("../../lib/modSettings/audit");
const { createRegistry } = require("../../lib/telemetry/registry");
const { createChatCommandHook } = require("../../lib/adapter/chatCommand");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOST = "127.0.0.1:26410";
const PILOT = 90000001;
const XMPP = Object.freeze({ transport: "xmpp" });
const BASE = resolveConfig({ env: {}, settings: {}, envFile: {}, modDir: MOD_DIR }).config;

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-modsettings-web-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function counterBytes() {
  let n = 0;
  return (size) => {
    n += 1;
    return Buffer.alloc(size, n);
  };
}

function fakeReq(method, url, headers = {}) {
  const req = new EventEmitter();
  Object.assign(req, { method, url, headers: { host: HOST, ...headers } });
  return req;
}

function fakeRes() {
  return {
    status: null, headers: {}, body: null, headersSent: false, destroyed: false,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(s, h) { this.status = s; Object.assign(this.headers, h || {}); this.headersSent = true; },
    end(b) { this.body = b === undefined ? "" : String(b); },
    destroy() { this.destroyed = true; },
    json() { return JSON.parse(this.body); },
  };
}

function send(handler, method, url, body, headers) {
  const req = fakeReq(method, url, headers);
  const res = fakeRes();
  handler(req, res);
  if (body !== undefined) req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
  req.emit("end");
  return res;
}

function call(routes, method, url, body, headers = {}) {
  const res = fakeRes();
  routes.handle(fakeReq(method, `/api/settings/${url}`, headers), res,
    body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
  return res;
}

function observerWith(ctx, extraConfig = {}) {
  let handler = null;
  const httpApi = { createServer(h) {
    handler = h;
    return { on() {}, listen() {}, unref() {}, address: () => null, close() {} };
  } };
  const config = { observer: { ...BASE.observer }, modSettings: { ...BASE.modSettings, ...extraConfig } };
  const r = startObserver({ config, ctx, views: createViewRegistry(), logger: { log() {} }, httpApi });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return { handler, observer: r.observer };
}

function fakeAdapter() {
  const installs = [];
  const removed = [];
  return { installs, removed,
    listLoadedModDirs: () => ({ ok: true, dirs: Object.freeze(["livingNewEden"]) }),
    loadModConfig: () => ({ ok: false, reason: "CONFIG_MISSING" }),
    installChatCommand: (opts) => { installs.push(opts); return { ok: true }; },
    uninstallChatCommand: (name) => { removed.push(name); return { ok: true }; } };
}

function startedPanel(dir, extra = {}) {
  const env = { EVEJS_DATA_ROOT: dir };
  const lneDir = path.join(dir, "mods", "livingNewEden");
  const now = { t: 1700000000000 };
  const config = { ...BASE, dataDir: lneDir, observer: { ...BASE.observer, enabled: extra.observer !== false },
    modSettings: { ...BASE.modSettings, enabled: true, mods: "livingNewEden", allowedCharacterIds: `${PILOT}, 5` } };
  const registry = createRegistry({ histogramSamples: 8, maxMetrics: 64 });
  const httpRoutes = createHttpRoutes();
  const adapter = fakeAdapter();
  const lines = [];
  const r = startModSettings({ config, adapter, env, modDir: MOD_DIR, clock: { now: () => now.t },
    telemetry: registry, logger: { log: (l) => lines.push(l) }, httpRoutes, randomBytes: counterBytes() });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const route = httpRoutes.match("/api/settings/mods");
  return { ms: r.modSettings, registry, httpRoutes, adapter, chat: adapter.installs[0], route, now, lneDir, lines };
}

function tokenOfReply(text) {
  const m = /#t=([A-Za-z0-9_-]{43})"/.exec(text);
  assert.ok(m, text);
  return m[1];
}

module.exports = ({ test }) => {
  test("MSW1 observer: a ctx.httpRoutes prefix goes to its route (Host, body limit 413, BASE_HEADERS, 500 internal), "
    + "the router serves every other path as before", () => {
    const routes = createHttpRoutes();
    assert.strictEqual(routes.register({ prefix: "/api/views/", handle() {} }).reason, "ROUTE_PREFIX_INVALID");
    assert.strictEqual(routes.register({ prefix: "/api/x", handle() {} }).reason, "ROUTE_PREFIX_INVALID");
    assert.strictEqual(routes.register({ prefix: "/api/x/" }).reason, "ROUTE_DEF_INVALID");
    const seen = [];
    const ok = routes.register({ prefix: "/api/x/", handle(req, res, body) {
      if (req.url.endsWith("/boom")) throw new Error("route broke");
      seen.push([req.method, req.url, body.toString("utf8")]);
      res.writeHead(201, { "Content-Type": "text/plain" });
      res.end("made");
    } });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(routes.register({ prefix: "/api/x/", handle() {} }).reason, "ROUTE_EXISTS");
    const counts = [];
    const ctx = { modVersion: "t", httpRoutes: routes, telemetry: { count: (n) => counts.push(n), noteOp() {} } };
    const { handler, observer } = observerWith(ctx, { maxBodyBytes: 16 });

    const made = send(handler, "POST", "/api/x/a?b=1", "{\"k\":1}");
    assert.deepStrictEqual([made.status, made.body], [201, "made"]);
    assert.deepStrictEqual(seen, [["POST", "/api/x/a?b=1", "{\"k\":1}"]]);
    for (const [k, v] of Object.entries(BASE_HEADERS)) assert.strictEqual(made.headers[k], v, k);
    const host = send(handler, "POST", "/api/x/a", "{}", { host: "evil.example" });
    assert.deepStrictEqual([host.status, host.json().reason], [403, "HOST_NOT_ALLOWED"]);
    const big = send(handler, "POST", "/api/x/a", "x".repeat(17));
    assert.deepStrictEqual([big.status, big.json().reason, big.headers["X-Frame-Options"]], [413, "BODY_TOO_LARGE",
      "DENY"]);
    const declared = send(handler, "POST", "/api/x/a", undefined, { "content-length": "17" });
    assert.strictEqual(declared.status, 413, "refused by Content-Length before the body");
    assert.strictEqual(seen.length, 1, "no handler call for a refusal");
    const boom = send(handler, "GET", "/api/x/boom");
    assert.deepStrictEqual([boom.status, boom.json().reason], [500, "internal"]);
    assert.ok(counts.includes("observer.errors"), counts.join());

    const list = send(handler, "GET", "/api/views");
    assert.deepStrictEqual([list.status, list.json().ok], [200, true]);
    const post = send(handler, "POST", "/api/views");
    assert.deepStrictEqual([post.status, post.headers.Allow, post.json().error.reason], [405, "GET",
      "METHOD_NOT_ALLOWED"]);
    assert.strictEqual(send(handler, "GET", "/api/xy").json().error.reason, "NOT_FOUND", "a prefix is a prefix");
    const page = send(handler, "GET", "/settings.html");
    assert.ok(page.headers["Content-Security-Policy"].includes("script-src 'self'"));
    ok.unregister();
    assert.strictEqual(send(handler, "POST", "/api/x/a").status, 405, "unregistered = the router again");
    observer.stop();
  });

  test("MSW2 sessions and routes: one-time token, expiry, eviction, cookie, NO_SESSION, CSRF, Origin, methods", () => {
    const now = { t: 1000 };
    const s = createSessions({ linkTtlMs: 600000, sessionTtlMs: 3600000, maxSessions: 2, clock: { now: () => now.t },
      randomBytes: counterBytes() });
    const t1 = s.issueToken({ characterId: PILOT, characterName: "Pilot\nOne" });
    assert.match(t1.token, /^[A-Za-z0-9_-]{43}$/);
    const a = s.redeem(t1.token);
    assert.deepStrictEqual([a.ok, a.actor], [true, { characterId: PILOT, characterName: "Pilot One" }]);
    assert.deepStrictEqual(s.redeem(t1.token), { ok: false, reason: "BAD_TOKEN" }, "a token works once");
    const late = s.issueToken({ characterId: PILOT });
    now.t += 600000;
    assert.strictEqual(s.redeem(late.token).reason, "BAD_TOKEN", "expired");
    assert.strictEqual(s.redeem("short").reason, "BAD_TOKEN");
    const b = s.redeem(s.issueToken({ characterId: 5 }).token);
    const c = s.redeem(s.issueToken({ characterId: 6 }).token);
    assert.deepStrictEqual([s.sessionOf(a.sid), s.sessionOf(b.sid).actor.characterId, s.sessionOf(c.sid).actor
      .characterId], [null, 5, 6], "the oldest session is evicted over maxSessions");
    assert.strictEqual(s.csrfMatches(s.sessionOf(b.sid), b.csrf), true);
    assert.strictEqual(s.csrfMatches(s.sessionOf(b.sid), c.csrf), false);
    now.t += 3600000;
    assert.strictEqual(s.sessionOf(b.sid), null, "idle lifetime");
    assert.deepStrictEqual([s.status().sessions, s.status().evicted], [0, 1]);

    const service = { listMods: () => [{ modId: "livingNewEden" }], describe: (id, q) => ({ ok: true, id, q }),
      set: (req) => ({ ok: false, reason: "LOCKED", req }), reset: () => ({ ok: true, changed: false }) };
    let up = true;
    const routes = createSettingsRoutes({ getModSettings: () => (up ? service : null), sessions: s });
    const token = s.issueToken({ characterId: PILOT, characterName: "Pilot" }).token;
    const evil = call(routes, "POST", "session", { token }, { origin: "http://evil.example" });
    assert.deepStrictEqual([evil.status, evil.json().reason], [403, "ORIGIN_NOT_ALLOWED"]);
    const opened = call(routes, "POST", "session", { token }, { origin: `http://${HOST}` });
    assert.strictEqual(opened.status, 200, opened.body);
    const cookie = opened.headers["Set-Cookie"];
    assert.match(cookie, /^lne_settings=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/api\/settings$/);
    const sid = cookie.split(";")[0];
    const { csrf } = opened.json();
    assert.strictEqual(call(routes, "POST", "session", { token }).status, 401, "token used");
    assert.deepStrictEqual([call(routes, "GET", "mods").status, call(routes, "GET", "mods").json().reason],
      [401, "NO_SESSION"]);
    const mods = call(routes, "GET", "mods", undefined, { cookie: `x=1; ${sid}` });
    assert.deepStrictEqual(mods.json(), { ok: true, character: { characterId: PILOT, characterName: "Pilot" },
      mods: [{ modId: "livingNewEden" }] });
    assert.deepStrictEqual(call(routes, "GET", "mods/livingNewEden?group=observer&q=journal&offset=20", undefined,
      { cookie: sid }).json(), { ok: true, id: "livingNewEden", q: { group: "observer", q: "journal", offset: 20 } });
    const body = { key: "observer.port", value: 1, expectedRevision: 0 };
    assert.deepStrictEqual([call(routes, "POST", "mods/livingNewEden/set", body, { cookie: sid }).json().reason,
      call(routes, "POST", "mods/livingNewEden/set", body, { cookie: sid, "x-lne-csrf": "bad" }).status],
    ["BAD_CSRF", 403]);
    const set = call(routes, "POST", "mods/livingNewEden/set", body, { cookie: sid, "x-lne-csrf": csrf,
      origin: "http://localhost:26410" });
    assert.deepStrictEqual([set.status, set.json().reason, set.json().req.actor], [200, "LOCKED",
      { characterId: PILOT, characterName: "Pilot", channel: "web" }], "the writer 1:1, the actor of the session");
    assert.deepStrictEqual([call(routes, "GET", "mods/livingNewEden/set", undefined, { cookie: sid }).status,
      call(routes, "GET", "nope", undefined, { cookie: sid }).status,
      call(routes, "GET", "mods/a%2Fb", undefined, { cookie: sid }).status], [405, 404, 400]);
    const bad = call(routes, "POST", "mods/livingNewEden/reset", undefined, { cookie: sid, "x-lne-csrf": csrf });
    assert.strictEqual(bad.status, 200, "an empty body is {}");
    up = false;
    assert.strictEqual(call(routes, "GET", "mods", undefined, { cookie: sid }).status, 503);
    up = true;
    const out = call(routes, "POST", "logout", {}, { cookie: sid, "x-lne-csrf": csrf });
    assert.deepStrictEqual([out.status, /Max-Age=0/.test(out.headers["Set-Cookie"])], [200, true]);
    assert.strictEqual(call(routes, "GET", "mods", undefined, { cookie: sid }).status, 401, "logged out");
  });

  test("MSW3 panel set/reset through the routes into the real writer: actor of the session, revision, audit, "
    + "secret row masked and LOCKED", () => withDir((dir) => {
    const p = startedPanel(dir);
    assert.ok(p.route, "routes registered");
    const token = tokenOfReply(p.chat.handle({ characterId: PILOT, name: "Pilot One" }, "!settings", XMPP));
    const opened = call(p.route, "POST", "session", { token });
    const sid = opened.headers["Set-Cookie"].split(";")[0];
    const h = { cookie: sid, "x-lne-csrf": opened.json().csrf };
    const page = call(p.route, "GET", "mods/livingNewEden?q=observer.journalLimit", undefined, h).json();
    assert.deepStrictEqual([page.ok, page.rows[0].key, page.overrideFile.revision], [true, "observer.journalLimit", 0]);
    assert.ok(page.groups.length > 0 && page.limit === BASE.modSettings.maxRowsPerPage, "groups in their own field");
    const set = call(p.route, "POST", "mods/livingNewEden/set", { key: "observer.journalLimit", value: 60,
      expectedRevision: 0 }, h).json();
    assert.deepStrictEqual(set, { ok: true, changed: true, revision: 1, apply: "restart", pending: true, warnings: [] });
    assert.strictEqual(call(p.route, "POST", "mods/livingNewEden/set", { key: "observer.journalLimit", value: 70,
      expectedRevision: 0 }, h).json().reason, "STALE_REVISION");
    const reset = call(p.route, "POST", "mods/livingNewEden/reset", { key: "observer.journalLimit",
      expectedRevision: 1 }, h).json();
    assert.deepStrictEqual([reset.ok, reset.changed, reset.revision, reset.pending], [true, true, 2, false]);
    const audit = fs.readFileSync(auditPathOf(p.lneDir), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepStrictEqual(audit.map((a) => [a.characterId, a.characterName, a.channel, a.action]),
      [[PILOT, "Pilot One", "web", "set"], [PILOT, "Pilot One", "web", "reset"]]);
    const secret = call(p.route, "GET", "mods/livingNewEden?q=chatterAi.baseUrl", undefined, h).json().rows
      .find((r) => r.key === "chatterAi.baseUrl");
    assert.deepStrictEqual([secret.running, secret.next, secret.locked], ["***", "***", true]);
    assert.strictEqual(call(p.route, "POST", "mods/livingNewEden/set", { key: "chatterAi.baseUrl",
      value: "x", expectedRevision: 2 }, h).json().reason, "LOCKED");
    assert.strictEqual(p.registry.counter("modSettings.sessions"), 1);
    p.ms.stop("test");
    assert.strictEqual(p.httpRoutes.match("/api/settings/mods"), null, "stop unregisters the routes");
    assert.deepStrictEqual(p.adapter.removed, ["settings"]);
  }));

  test("MSW4 !settings: allowlist + denied, cooldown, link with the token in the fragment and a copy line, "
    + "observer off, stopped, match", () => withDir((dir) => {
    const p = startedPanel(dir);
    assert.deepStrictEqual([p.chat.name, p.chat.match("!settings"), p.chat.match("! Settings x"),
      p.chat.match("!settingsx")], ["settings", true, true, false]);
    assert.strictEqual(p.chat.handle({ characterId: 42, name: "Other" }), "LNE settings: not allowed");
    assert.strictEqual(p.registry.counter("modSettings.denied"), 1);
    const text = p.chat.handle({ characterId: PILOT, name: "Pilot One" }, "!settings", XMPP);
    const port = BASE.observer.port;
    const token = tokenOfReply(text);
    const href = `http://127.0.0.1:${port}/settings.html#t=${token}`;
    assert.strictEqual(text, `LNE settings: <a href="${href}">Mod settings</a>${BASE.frontChat.lineBreak}(${href} - opens in your browser, `
      + `one use, valid ${BASE.modSettings.linkTtlMs / 60000} min)`);
    assert.match(p.chat.handle({ characterId: PILOT }, "!settings", XMPP),
      /^LNE settings: wait \d+ s before the next !settings$/);
    p.now.t += BASE.modSettings.cooldownMs;
    assert.notStrictEqual(tokenOfReply(p.chat.handle({ characterId: PILOT }, "!settings", XMPP)), token,
      "a new token each time");
    assert.strictEqual(p.registry.counter("modSettings.links"), 2);
    assert.strictEqual(p.chat.handle(null), "LNE settings unavailable (NO_CHARACTER)");
    p.ms.stop("test");
    assert.strictEqual(p.chat.handle({ characterId: PILOT }), "LNE settings unavailable (STOPPED)");

    const off = startedPanel(path.join(dir, "off"), { observer: false });
    assert.strictEqual(off.chat.handle({ characterId: PILOT }, "!settings", XMPP),
      "LNE settings: the observer is off (observer.enabled)");
    assert.deepStrictEqual(off.ms.getStatus().web, { routes: "active", chat: "active", tokens: 0, sessions: 0,
      issued: 0, redeemed: 0, refused: 0, evicted: 0, expired: 0 });
  }));

  test("MSW5 !settings off the XMPP path (gateway, LSC, unknown, no ctx): refusal without #t=, no token issued, "
    + "no cooldown used; the XMPP caller still gets the link", () => withDir((dir) => {
    const p = startedPanel(dir);
    const runtime = { broadcastLocalMessage: (_s, m) => ({ entry: { message: m } }) };
    const hook = createChatCommandHook({ chatRuntimeExports: runtime, match: p.chat.match, handle: p.chat.handle });
    assert.deepStrictEqual(hook.install(), { ok: true });
    const callerIn = (file) => vm.runInThisContext("(function vendorCaller(fn, s, m) { return fn(s, m); })",
      { filename: path.join(dir, "server", "src", file) });
    const session = { characterID: PILOT, characterName: "Pilot One", solarsystemid2: 30000142 };
    const replyVia = (file) => {
      try {
        callerIn(file)(runtime.broadcastLocalMessage, session, "!settings");
      } catch (err) {
        return err.message;
      }
      return null;
    };
    const refusal = "LNE settings: no link on this chat path, type !settings in the Local window";
    const paths = ["_secondary/express/gatewayServices/localChatGatewayService.js", "services/chat/chatHub.js",
      "services/chat/lscService.js", "somewhere/else.js"];
    for (const file of paths) {
      const text = replyVia(file);
      assert.strictEqual(text, refusal, file);
      assert.ok(!text.includes("#t="), `${file}: no token in the reply`);
    }
    assert.strictEqual(p.chat.handle({ characterId: PILOT }, "!settings"), refusal, "no ctx = not private");
    assert.strictEqual(p.chat.handle({ characterId: PILOT }, "!settings", { transport: "gateway" }), refusal);
    assert.deepStrictEqual([p.ms.getStatus().web.issued, p.ms.getStatus().web.tokens,
      p.registry.counter("modSettings.links")], [0, 0, 0], "no token was issued");
    assert.ok(p.lines.some((l) => /!settings refused for character 90000001 - transport gateway is not private/.test(l)),
      p.lines.join("\n"));
    assert.ok(!p.lines.some((l) => l.includes("#t=")), "no token in the mod log");
    const text = replyVia("services/chat/xmppStubServer.js");
    assert.ok(tokenOfReply(text).length === 43, text);
    assert.strictEqual(p.ms.getStatus().web.issued, 1);
    hook.uninstall();
  }));
};
