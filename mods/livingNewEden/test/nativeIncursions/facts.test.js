"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { PLACEMENT_SHA1 } = require("../../lib/adapter/incursionNative");
const { startNativeIncursions } = require("../../lib/nativeIncursions");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const FILES = Object.freeze({
  placement: path.join(SERVER_SRC, "services", "incursion", "incursionFocusPlacement.js"),
  runtime: path.join(SERVER_SRC, "services", "incursion", "incursionFocusRuntime.js"),
  lifecycle: path.join(SERVER_SRC, "services", "incursion", "incursionLifecycle.js"),
  lifecycleScheduler: path.join(SERVER_SRC, "services", "incursion", "incursionLifecycleScheduler.js"),
  production: path.join(SERVER_SRC, "services", "scheduler", "productionSchedulerRuntime.js"),
});
const COMPOSE_KEYS = Object.freeze(["EVEJS_LNE_NATIVE_INCURSIONS_ENABLED", "EVEJS_LNE_NATIVE_INCURSIONS_STEER_ENABLED",
  "EVEJS_LNE_NATIVE_INCURSIONS_STEER_MODE", "EVEJS_LNE_NATIVE_INCURSIONS_SETTLE_ENABLED"]);

const textOf = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const count = (text, needle) => text.split(needle).length - 1;

module.exports = ({ test, skip }) => {
  const name = "NI5 vendor facts of the steering seam + nativeIncursions.* defaults off + compose keys";
  const missing = Object.values(FILES).filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    skip(name, `vendor file not found: ${missing.map((f) => path.basename(f)).join(", ")}`);
    return;
  }
  test(name, () => {
    const placement = textOf(FILES.placement);
    assert.strictEqual(crypto.createHash("sha1").update(placement).digest("hex"), PLACEMENT_SHA1, "placement SHA-1");
    assert.ok(placement.includes("\nmodule.exports = { VERSION, policy, buildCatalog, loadCatalog, selectPlacement, "),
      "selectPlacement exported by the module object");
    const runtime = textOf(FILES.runtime);
    assert.strictEqual(count(runtime, "selectPlacement("), 1, "one call of selectPlacement");
    assert.strictEqual(count(runtime, "placement.selectPlacement(geography, {"), 1, "through the module object");
    assert.strictEqual(count(runtime, "const placement = require(\"./incursionFocusPlacement\")"), 1);
    const lifecycle = textOf(FILES.lifecycle);
    assert.ok(lifecycle.includes("return { createTale, getTale, listTales,"), "listTales on the lifecycle facade");
    assert.ok(lifecycle.includes("    subscribe(listener) {"), "subscribe on the lifecycle facade");
    assert.ok(lifecycle.includes("module.exports = { ...createIncursionLifecycle(), createIncursionLifecycle, ID_BASE };"));
    const scheduler = textOf(FILES.lifecycleScheduler);
    assert.ok(scheduler.includes("const JOB_TYPE = \"incursion.lifecycle\";"));
    assert.ok(scheduler.includes("(!options.lifecycle ? require(\"./incursionFocusRuntime\") : null)"),
      "the job handler uses the focus runtime of the same require cache");
    const production = textOf(FILES.production);
    assert.ok(production.includes("require(\"../incursion/incursionLifecycleScheduler\")"));
    assert.ok(production.includes("scheduler.register(incursionLifecycleOwner.JOB_TYPE, job => "
      + "incursionLifecycleOwner.handleJob(job))"), "job registered in the production scheduler");

    const rows = config.SCHEMA.filter((row) => row.key.startsWith("nativeIncursions."));
    assert.ok(rows.length >= 14, `nativeIncursions.* rows: ${rows.length}`);
    const flags = rows.filter((row) => row.type === "boolean");
    assert.deepStrictEqual(flags.map((row) => [row.key, row.default]), [["nativeIncursions.enabled", false],
      ["nativeIncursions.steer.enabled", false], ["nativeIncursions.settle.enabled", false],
      ["nativeIncursions.newsEnabled", false], ["nativeIncursions.observerEnabled", false],
      ["nativeIncursions.noticesEnabled", false], ["nativeIncursions.rewards.enabled", false]]);
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.deepStrictEqual(r.errors || [], []);
    let touched = 0;
    const adapter = new Proxy({}, { get() {
      touched += 1;
      return () => ({ ok: true });
    } });
    assert.deepStrictEqual(startNativeIncursions({ config: r.config, clock: { now: () => 1 }, adapter,
      persistence: { ok: true, store: {}, journal: {} } }), { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(touched, 0, "flag off: no adapter call");
    const kill = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_NATIVE_INCURSIONS_ENABLED: "0", EVEJS_LNE_NATIVE_INCURSIONS_STEER_ENABLED: "1" } });
    assert.strictEqual(startNativeIncursions({ config: kill.config, clock: { now: () => 1 }, adapter,
      persistence: { ok: true, store: {}, journal: {} } }).reason, "disabled_by_config", "kill switch");

    const composeFile = findCompose();
    if (!composeFile) return;
    const text = fs.readFileSync(composeFile, "utf8");
    const { env } = readCompose(composeFile);
    for (const key of COMPOSE_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(env, key), `compose env ${key}`);
      assert.ok(text.includes(`\${${key}:-}`), `compose \${${key}:-}`);
    }
  });
};
