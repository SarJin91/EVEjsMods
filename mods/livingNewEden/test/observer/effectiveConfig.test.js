"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SCHEMA, MODULE_NAMES, RESERVED_ENV, resolveConfig } = require("../../config");
const { buildDefaultServiceDefs } = require("../../lib/runtime/services");
const { createViewRegistry } = require("../../lib/observer/views");
const { startObserver } = require("../../lib/observer");
const { buildStatusView } = require("../../lib/observer/builtinViews");
const {
  isFlagRow, isSecretRow, redactConfigValues, redactPaths, serviceFlagKey, describeConfig,
} =require("../../lib/observer/effectiveConfig");
const { VIEW_ID, buildEffectiveConfigView } = require("../../lib/observer/views/effectiveConfig");
const { DEFAULT_COMPOSE, buildReport, main } = require("../../tools/effectiveConfig");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const fakeHttp = { createServer: () => ({ on() {}, listen() {}, unref() {}, close() {}, address: () => null }) };
const UNMAPPED_SERVICES = Object.freeze(["beltNavy", "blockade", "fortress", "governor", "gridDefense", "loyalty",
  "playerSovSiege"]);

function resolved(env) {
  return resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR });
}

function describe(r, services) {
  return describeConfig({ schema: SCHEMA, config: r.config, sources: r.sources, warnings: r.warnings,
    errors: r.errors, services, originChars: 120 });
}

function flagOf(d, key) {
  const f = d.flags.find((x) => x.key === key);
  assert.ok(f, `no flag ${key}`);
  return f;
}

function envOf(key) {
  return SCHEMA.find((r) => r.key === key).env;
}

module.exports = ({ test }) => {
  test("EC1 default config: every flag listed, no drift, only the secret rows masked, no warnings", () => {
    const r = resolved({});
    const d = describe(r, null);
    assert.strictEqual(d.flags.length, SCHEMA.filter(isFlagRow).length);
    for (const n of MODULE_NAMES) flagOf(d, `modules.${n}.enabled`);
    assert.strictEqual(d.summary.differs, 0);
    assert.strictEqual(d.summary.pinned, 0);
    assert.deepStrictEqual(d.overrides, []);
    assert.deepStrictEqual(d.masked, ["alerts.webhookUrl", "chatterAi.apiKey", "chatterAi.dailyTokenBudget",
      "chatterAi.voiceTokenSharePermille", "chatterAi.talkTokenSharePermille", "chatterAi.newsTokenSharePermille",
      "chatterAi.plotTokenSharePermille",
      "shipAi.apiKey",
      "shipAi.dailyTokenBudget"],
      "a key read as a secret is a decision (secret:true), not a quiet mask");
    assert.deepStrictEqual(d.warnings, []);
    assert.deepStrictEqual(d.errors, []);
    assert.ok(d.flags.every((f) => f.origin.length <= 120));
  });

  test("EC2 sources and states: differs, pinned, shadowed by a parent, refused / shadowed by the registry", () => {
    const maxFleets = SCHEMA.find((x) => x.key === "limits.maxVirtualFleets").default;
    const r = resolved({
      [envOf("tribute.enabled")]: "1", [envOf("limits.maxVirtualFleets")]: String(maxFleets),
      [envOf("liberation.enabled")]: "0", [envOf("hunt.enabled")]: "1",
      [envOf("modules.materialization.enabled")]: "1",
    });
    const services = { refusal: null, services: [
      { name: "hunt", module: "strategy", state: "failed", reason: "HUNT_FACADE_MISSING", detail: null },
      { name: "materialization", module: "materialization", state: "disabled", reason: "dependency_disabled:battle",
        detail: null },
      { name: "observer", module: null, state: "running", reason: null, detail: null },
    ] };
    const d = describe(r, services);
    const tribute = flagOf(d, "tribute.enabled");
    assert.deepStrictEqual([tribute.value, tribute.default, tribute.source, tribute.differs, tribute.pinned, tribute.state],
      [true, false, "environment", true, false, "on"]);
    const pinned = d.overrides.find((o) => o.key === "limits.maxVirtualFleets");
    assert.deepStrictEqual(pinned, { key: "limits.maxVirtualFleets", value: maxFleets, default: maxFleets,
      source: "environment", differs: false, pinned: true });
    const rewards = flagOf(d, "liberation.rewardsEnabled");
    assert.deepStrictEqual([rewards.state, rewards.by], ["shadowed", "liberation.enabled"]);
    assert.strictEqual(flagOf(d, "liberation.enabled").state, "off");
    const hunt = flagOf(d, "hunt.enabled");
    assert.deepStrictEqual([hunt.state, hunt.by, hunt.service], ["refused", "HUNT_FACADE_MISSING", "hunt"]);
    const mat = flagOf(d, "modules.materialization.enabled");
    assert.deepStrictEqual([mat.state, mat.by], ["shadowed", "dependency_disabled:battle"]);
    assert.strictEqual(flagOf(d, "observer.enabled").state, "on");
    assert.strictEqual(d.summary.differs, 3, JSON.stringify(d.flags.filter((f) => f.differs).map((f) => f.key)));
    assert.strictEqual(d.summary.pinned, 2, "limits.maxVirtualFleets and hunt.enabled (default true)");

    const keys = new Set(SCHEMA.map((x) => x.key));
    const unmapped = buildDefaultServiceDefs().map((s) => s.name).filter((n) => serviceFlagKey(n, keys) === null);
    assert.deepStrictEqual(unmapped.sort(), [...UNMAPPED_SERVICES].sort());
  });

  test("EC3 secrets: word rule and secret:true masked in panel, config copy and status view; look-alikes plain", () => {
    const schema = [
      { key: "x.apiToken", type: "string", default: "", env: "EVEJS_LNE_X_API_TOKEN" },
      { key: "x.dbPassword", type: "string", default: "", env: "EVEJS_LNE_X_DB_PASSWORD" },
      { key: "x.signingKey", type: "string", default: "k0", env: "EVEJS_LNE_X_SIGNING_KEY", secret: true },
      { key: "x.maxRowsPerPass", type: "integer", default: 8, env: "EVEJS_LNE_X_MAX_ROWS_PER_PASS" },
      { key: "trade.privateOffersEnabled", type: "boolean", default: false,
        env: "EVEJS_LNE_TRADE_PRIVATE_OFFERS_ENABLED" },
    ];
    assert.deepStrictEqual(schema.map(isSecretRow), [true, true, true, false, false]);
    assert.deepStrictEqual([
      { key: "y.apikey", type: "string", default: "", env: "EVEJS_LNE_Y_SVC" },
      { key: "y.bearerHeader", type: "string", default: "", env: "EVEJS_LNE_Y_HDR" },
      { key: "y.walletCode", type: "string", default: "", env: "EVEJS_LNE_Y_WALLET_PASSPHRASE" },
    ].map(isSecretRow), [true, true, true]);
    const config = Object.freeze({ x: Object.freeze({ apiToken: "abc", dbPassword: "hunter2", signingKey: "sig",
      maxRowsPerPass: 9 }), trade: Object.freeze({ privateOffersEnabled: true }) });
    const sources = Object.fromEntries(schema.map((r) => [r.key, "environment"]));
    const warnings = ["EVEJS_LNE_X_API_TOKEN=abc is not a text - ignored", "EVEJS_LNE_X_MAX_ROWS_PER_PASS=x is not a number"];
    const d = describeConfig({ schema, config, sources, warnings, errors: [], services: null, originChars: 0 });
    assert.deepStrictEqual(d.masked, ["x.apiToken", "x.dbPassword", "x.signingKey"]);
    for (const k of d.masked) {
      const o = d.overrides.find((x) => x.key === k);
      assert.deepStrictEqual([o.value, o.default, o.differs], ["***", "***", true]);
    }
    assert.strictEqual(d.overrides.find((x) => x.key === "x.maxRowsPerPass").value, 9);
    assert.strictEqual(flagOf(d, "trade.privateOffersEnabled").value, true);
    assert.deepStrictEqual(d.warnings, ["<redacted: x.apiToken>", "EVEJS_LNE_X_MAX_ROWS_PER_PASS=x is not a number"]);

    const copy = redactConfigValues(config, schema);
    assert.deepStrictEqual(copy.x, { apiToken: "***", dbPassword: "***", signingKey: "***", maxRowsPerPass: 9 });
    assert.strictEqual(config.x.apiToken, "abc", "input not changed");

    const status = buildStatusView({ ctx: { config, state: { configResult: { sources, warnings, errors: [] } } },
      config: {}, getObserverStats: () => ({}), schema }).getData();
    assert.strictEqual(status.config.values.x.dbPassword, "***");
    const text = JSON.stringify({ d, status });
    for (const secret of ["abc", "hunter2", "\"sig\""]) assert.ok(!text.includes(secret), `${secret} leaked`);
  });

  test("EC4 view: sizes and base name, retention without cursors, no store, cacheKey bucket, flag registration", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-effcfg-"));
    try {
      const file = path.join(dir, "world.sqlite");
      fs.writeFileSync(file, Buffer.alloc(4096));
      fs.writeFileSync(`${file}-wal`, Buffer.alloc(100));
      const on = { getStatus: () => ({ state: "on", params: { dryRun: false }, counters: { sweeps: 1 },
        classes: { done: { scanned: 5, deleted: 2, candidates: 2, sweeps: 1, afterKey: "secret-cursor", guarded: 1,
          lastSweepAt: 1234 }, fresh: { scanned: 0, deleted: 0, candidates: 0, sweeps: 0 } },
        lastRefusal: null, cursor: { done: "secret-cursor" }, bootstrap: null }) };
      const settings = { refreshMs: 10000, originChars: 0 };
      const view = buildEffectiveConfigView({ ctx: { config: { retention: { disabledClasses: "" } }, retention: on },
        schema: SCHEMA, store: () => ({ filePath: file }), settings });
      const data = view.getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.deepStrictEqual(data.database, { available: true, file: "world.sqlite", dbBytes: 4096, walBytes: 100,
        shmBytes: null, totalBytes: 4196 });
      assert.ok(!/[\\/]/.test(data.database.file));
      assert.strictEqual(data.retention.state, "on");
      assert.deepStrictEqual(data.retention.classes, [
        { id: "done", scanned: 5, deleted: 2, candidates: 2, sweeps: 1, guarded: 1, lastSweepAt: 1234 },
        { id: "fresh", scanned: 0, deleted: 0, candidates: 0, sweeps: 0, guarded: null, lastSweepAt: null }]);
      assert.ok(!JSON.stringify(data).includes("secret-cursor"));
      assert.ok(!JSON.stringify(data).includes(dir), "no host path");
      assert.ok(data.flags.length > 0 && data.flags.every((f) => f.state === "unknown" || f.service === null),
        "no registry: a flag with a service is unknown");

      const off = buildEffectiveConfigView({ ctx: { retention: { getStatus: () => ({ state: "unavailable",
        reason: "disabled_by_config" }) } }, schema: SCHEMA, store: () => null, settings }).getData();
      assert.deepStrictEqual(off.retention, { state: "unavailable", reason: "disabled_by_config", disabledClasses: "" });
      assert.deepStrictEqual(off.database, { available: false, reason: "PERSISTENCE_UNAVAILABLE" });
      assert.strictEqual(view.cacheKey({ nowMs: 10000 }), view.cacheKey({ nowMs: 19999 }));
      assert.notStrictEqual(view.cacheKey({ nowMs: 19999 }), view.cacheKey({ nowMs: 20000 }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const defaults = resolved({}).config.observer;
    assert.strictEqual(defaults.effectiveConfigEnabled, false, "off by default");
    for (const enabled of [false, true]) {
      const views = createViewRegistry();
      const obs = startObserver({ config: { observer: { ...defaults, port: 0, effectiveConfigEnabled: enabled } },
        ctx: {}, views, httpApi: fakeHttp });
      assert.strictEqual(obs.ok, true, JSON.stringify(obs));
      assert.strictEqual(views.listViews().some((x) => x.id === VIEW_ID), enabled);
      if (enabled) {
        const data = views.getView(VIEW_ID).getData();
        assert.strictEqual(data.available, true);
        assert.strictEqual(data.database.reason, "PERSISTENCE_UNAVAILABLE");
      }
      obs.observer.stop();
    }
  });

  test("EC6 no host path: status drops config.dataDir, refused `by` is the state code without the detail", () => {
    const dir = path.join(os.tmpdir(), "lne-effcfg-leak", "mods", "livingNewEden");
    const r = resolved({ [envOf("hunt.enabled")]: "1" });
    const config = { ...r.config, dataDir: dir };
    const services = { refusal: null, services: [
      { name: "hunt", module: "strategy", state: "failed", reason: "DATA_DIR_UNAVAILABLE",
        detail: `EACCES: permission denied, mkdir '${dir}'` },
    ] };
    const status = buildStatusView({ ctx: { config, state: { configResult: { sources: r.sources } } },
      config: {}, getObserverStats: () => ({}), schema: SCHEMA }).getData();
    assert.strictEqual(Object.prototype.hasOwnProperty.call(status.config.values, "dataDir"), false);
    assert.strictEqual(config.dataDir, dir, "input not changed");
    assert.ok(!JSON.stringify(status.config).includes("lne-effcfg-leak"), "no data dir in status.config");
    const d = describe({ ...r, config }, services);
    assert.deepStrictEqual([flagOf(d, "hunt.enabled").state, flagOf(d, "hunt.enabled").by],
      ["refused", "DATA_DIR_UNAVAILABLE"]);
    assert.ok(!JSON.stringify(d).includes("lne-effcfg-leak"), "no host path in the panel");
  });

  test("EC7 no host path in any observer answer: service, persistence and retention detail", () => {
    const dir = path.join(os.tmpdir(), "lne-detail-leak", "mods", "livingNewEden");
    const winDir = "C:\\Program Files\\lne-detail-leak\\data";
    const services = { refusal: null, stopped: false, services: [
      { name: "hunt", module: "strategy", state: "failed", reason: "DATA_DIR_UNAVAILABLE",
        detail: `EACCES: permission denied, mkdir '${dir}'` },
      { name: "retention", module: "persistence", state: "failed", reason: "DB_PATH_IN_MOD_DIR",
        detail: `${winDir}\\world.sqlite` },
    ] };
    const ctx = {
      config: { ...resolved({}).config, dataDir: dir },
      services: { getStatus: () => services },
      persistence: { ok: false, reason: "DB_PATH_IN_MOD_DIR", detail: path.join(dir, "world.sqlite") },
      retention: { getStatus: () => ({ state: "unavailable", reason: "DATA_DIR_UNAVAILABLE",
        detail: `ENOENT: no such file or directory, open '${winDir}\\x.db'` }) },
    };
    let handler = null;
    const http = { createServer: (h) => { handler = h; return fakeHttp.createServer(); } };
    const views = createViewRegistry();
    const obs = startObserver({ config: { observer: { ...ctx.config.observer, port: 0, effectiveConfigEnabled: true } },
      ctx, views, httpApi: http });
    assert.strictEqual(obs.ok, true, JSON.stringify(obs));
    const get = (url) => {
      const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = String(b); },
        destroy() {} };
      handler({ method: "GET", url, headers: { host: "127.0.0.1" } }, res);
      return res;
    };
    const ids = [...views.listViews(), ...views.listMapLayers()].map((v) => v.id);
    assert.ok(ids.includes("status") && ids.includes(VIEW_ID), ids.join(","));
    for (const id of ids) {
      const res = get(`/api/views/${id}`);
      assert.ok(!res.body.includes("lne-detail-leak"), `${id}: ${res.body.slice(0, 300)}`);
    }
    const status = JSON.parse(get("/api/views/status").body).data;
    assert.deepStrictEqual(status.services.services.map((s) => s.detail),
      ["EACCES: permission denied, mkdir '<path>/livingNewEden'", "<path>/world.sqlite"]);
    assert.strictEqual(status.persistence.detail, "<path>/world.sqlite");
    const panel = JSON.parse(get(`/api/views/${VIEW_ID}`).body).data;
    assert.strictEqual(panel.retention.detail, "ENOENT: no such file or directory, open '<path>/x.db'");
    assert.ok(ctx.persistence.detail.includes("lne-detail-leak"), "input not changed (logs keep the path)");
    obs.observer.stop();

    assert.strictEqual(redactPaths("GET http://127.0.0.1:26410/api/views ok"), "GET http://127.0.0.1:26410/api/views ok");
    assert.strictEqual(redactPaths("/app.js 3/5 a/b"), "/app.js 3/5 a/b");
    assert.strictEqual(redactPaths("\\\\host\\share\\a.db is inside /x/y/z/"), "<path>/a.db is inside <path>/z");
    assert.strictEqual(redactPaths("cd /aggregates/ ok"), "cd /aggregates/ ok");
    assert.strictEqual(redactPaths("C:\\d\\x.db 3/5 failed"), "<path>/x.db 3/5 failed");
    assert.strictEqual(redactPaths('{"m":"open\\n/var/lib/lne/x.db\\nnext"}'), '{"m":"open\\n<path>/x.db\\nnext"}');
    assert.strictEqual(redactPaths("file:/x/y and file:///a/b/c.db"), "file:<path>/y and file://<path>/c.db");
    assert.strictEqual(redactPaths('{"v":"\\\\x"}'), '{"v":"\\\\x"}');
    assert.strictEqual(redactPaths("\\Users\\me\\x.db gone"), "<path>/x.db gone");
    assert.strictEqual(redactPaths("open \\\\srv\\share\\x.db failed"), "open <path>/x.db failed");
    assert.strictEqual(redactPaths(JSON.stringify({ p: "\\\\srv\\share\\x.db" })), '{"p":"<path>/x.db"}');
    assert.strictEqual(redactPaths("ratio 3/5, a/b in a line: ok"), "ratio 3/5, a/b in a line: ok");
  });

  test("EC5 tool: the strict liveSim compose parser; a refusal is a report with exit 0; every EVEJS_LNE_* "
    + "of compose.yaml is a setting or reserved", () => {
    const head = ["services:", "  server:", "    environment:"];
    const fixture = [...head,
      "      EVEJS_LNE_A: ${EVEJS_LNE_A:-0}",
      "      EVEJS_LNE_C: \"lit\"",
      "      EVEJS_LNE_D: 5 # comment",
      "      EVEJS_LNE_E: ${EVEJS_LNE_E:-}",
    ].join("\n");
    const ok = buildReport(fixture);
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.deepStrictEqual([ok.service, ok.composeKeys, ok.emptyDefaults, ok.unresolved],
      ["server", 3, 1, undefined]);
    assert.deepStrictEqual(ok.names, ["EVEJS_LNE_A", "EVEJS_LNE_C", "EVEJS_LNE_D", "EVEJS_LNE_E"]);
    const refusedText = [...head, "      EVEJS_LNE_B: ${EVEJS_LNE_B}"].join("\n");
    const refused = buildReport(refusedText);
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "ARGS_INVALID"], JSON.stringify(refused));
    const outs = [];
    assert.strictEqual(main({ argv: ["--compose", "x.yaml"], readFile: () => refusedText, out: (t) => outs.push(t) }), 0);
    assert.strictEqual(outs.length, 1);
    assert.ok(outs[0].startsWith("effectiveConfig: compose refused - compose line "), outs[0]);
    const real = buildReport(fs.readFileSync(DEFAULT_COMPOSE, "utf8"));
    assert.strictEqual(real.ok, true, JSON.stringify(real.detail));
    const known = new Set([...SCHEMA.map((r) => r.env), ...RESERVED_ENV]);
    assert.ok(real.names.length > 0);
    assert.deepStrictEqual(real.names.filter((n) => !known.has(n)), []);
  });
};
