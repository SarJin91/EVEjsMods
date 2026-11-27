"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const ADAPTER_DIR = path.join(MOD_DIR, "lib", "adapter");
const SERVER_SEARCH_MAX_DEPTH = 5;

function findSrcDir() {
  const found = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
  return found.ok ? found.srcDir : null;
}

function findServerDir() {
  const src = findSrcDir();
  return src ? path.dirname(src) : null;
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exportBlocks(source) {
  const blocks = [];
  for (const start of source.matchAll(/^(module\.exports\s*=\s*\{|Object\.assign\(module\.exports,\s*\{)/gm)) {
    const rest = source.slice(start.index);
    const end = rest.search(/^\}\)?;/m);
    blocks.push(end === -1 ? rest : rest.slice(0, end));
  }
  return blocks.join("\n");
}

const FOUR_SPACE_EXPORTS = Object.freeze({
  "services/structure/structureState": Object.freeze(["registerStructureChangeListener"]),
});

const ASSIGNED_EXPORTS = Object.freeze({
  "space/runtime": Object.freeze(["droneInterop"]),
});

const SPREAD_EXPORTS = Object.freeze({
  "services/online/characterControlRuntime": Object.freeze({ spread: "defaultRuntime",
    names: Object.freeze(["getCharacterControlSnapshot"]) }),
});

const INLINE_EXPORTS = Object.freeze({
  "services/starbase/starbaseDefenseRuntime": Object.freeze(["getBatteryProfile", "getBatteryModuleView",
    "getBatterySession", "stopBattery"]),
  "services/starbase/starbaseInventoryRuntime": Object.freeze(["validateBatteryAmmoInventoryAccess",
    "getBatteryAmmoCapacity"]),
  "services/sovereignty/skyhookRaidRules": Object.freeze(["isWindowOpen"]),
  "services/incursion/incursionLifecycleContract": Object.freeze(["organicSchedulingEnabled"]),
});

const HEAD_LINE_EXPORTS = Object.freeze({
  "services/dynamic/essRepository": Object.freeze(["read", "write", "mutate", "check", "TABLE_NAME"]),
  "services/dynamic/essSettlementRuntime": Object.freeze(["handleJob", "reconcile"]),
  "services/scheduler/durableScheduler": Object.freeze(["createDurableScheduler"]),
  "services/dynamic/dynamicBountyRuntime": Object.freeze(["maintain", "recoverLosses"]),
  "services/sovereignty/skyhookHarvest": Object.freeze(["settleSkyhookHarvest"]),
  "space/entityConstants": Object.freeze(["ENTITY_TYPE"]),
  "services/incursion/incursionFocusPlacement": Object.freeze(["selectPlacement"]),
  "services/incursion/incursionLifecycleContract": Object.freeze(["fingerprint"]),
  "services/incursion/incursionRewardStore": Object.freeze(["read"]),
  "services/incursion/incursionSystemEffects": Object.freeze(["shipModifiers", "damageMultiplier", "bountyMultiplier",
    "blocksCyno"]),
  "services/incursion/incursionSystemEffectContract": Object.freeze(["VERSION", "RESONANCES", "policy"]),
  "space/FireShow/showIdentity": Object.freeze(["isFireShowShip"]),
});

const FACTORY_SPREAD_EXPORTS = Object.freeze({
  "services/incursion/incursionLifecycle": Object.freeze({ factory: "createIncursionLifecycle",
    names: Object.freeze(["listTales", "getTale"]) }),
});

function factorySpreadExportsName(source, entryPath, name) {
  const spec = FACTORY_SPREAD_EXPORTS[entryPath];
  if (!spec || !spec.names.includes(name)) return false;
  const text = source.replace(/\r\n/g, "\n");
  const f = escapeRe(spec.factory);
  if (!new RegExp(`^module\\.exports = \\{ \\.\\.\\.${f}\\(\\),`, "m").test(text)) return false;
  const start = text.search(new RegExp(`^function ${f}\\(`, "m"));
  const end = start < 0 ? -1 : text.indexOf("\n}\n", start);
  if (end < 0) return false;
  return new RegExp(`\\n {2}return \\{[^\\n]*\\b${escapeRe(name)},`).test(text.slice(start, end));
}

const PUBLISHED_FACADE_EXPORTS = Object.freeze({
  "abyssal/policy/abyssalSpaceRuntimeIntegration": Object.freeze(["getActiveAbyssalRunForCharacterID"]),
});

function publishedFacadeName(source, entryPath, name) {
  if (!(PUBLISHED_FACADE_EXPORTS[entryPath] || []).includes(name)) return false;
  const text = source.replace(/\r\n/g, "\n");
  const at = text.indexOf("\nmodule.exports = createPublishedFacade([\n");
  if (at < 0) return false;
  const end = text.indexOf("\n]);", at);
  return end > at && text.slice(at, end).includes(`\n  "${name}",`);
}

const MIXED_LINE_EXPORTS = Object.freeze({
  "services/dynamic/essSettlementRuntime": Object.freeze(["synchronize", "schedule"]),
});

function mixedLineExportsName(source, entryPath, name) {
  if (!(MIXED_LINE_EXPORTS[entryPath] || []).includes(name)) return false;
  return new RegExp(`^ {2}\\w[^\\n]*, ${escapeRe(name)}(,|:)`, "m").test(exportBlocks(source.replace(/\r\n/g, "\n")));
}

function headLineExportsName(source, entryPath, name) {
  if (!(HEAD_LINE_EXPORTS[entryPath] || []).includes(name)) return false;
  return new RegExp(`^module\\.exports = \\{ (?:[\\w]+(?:: [\\w.]+)?, )*${escapeRe(name)}(,| \\};)`, "m")
    .test(source.replace(/\r\n/g, "\n"));
}

function inlineExportsName(source, entryPath, name) {
  if (!(INLINE_EXPORTS[entryPath] || []).includes(name)) return false;
  return new RegExp(`^ {2}(?:\\w+, )+${escapeRe(name)},`, "m").test(exportBlocks(source.replace(/\r\n/g, "\n")));
}

function spreadExportsName(source, entryPath, name) {
  const spec = SPREAD_EXPORTS[entryPath];
  if (!spec || !spec.names.includes(name)) return false;
  const text = source.replace(/\r\n/g, "\n");
  const at = text.lastIndexOf("\nmodule.exports = {");
  const factory = text.lastIndexOf("\n  return Object.freeze({", at);
  if (at < 0 || factory < 0) return false;
  const factoryEnd = text.indexOf("\n  });", factory);
  return new RegExp(`\\n {2}\\.\\.\\.${escapeRe(spec.spread)},`).test(text.slice(at))
    && new RegExp(`\\nconst ${escapeRe(spec.spread)} = createCharacterControlRuntime\\(`).test(text)
    && factoryEnd > factory && new RegExp(`\\n {4}${escapeRe(name)},`).test(text.slice(factory, factoryEnd));
}

function exportsName(source, name, fourSpaceNames = []) {
  const n = escapeRe(name);
  const blocks = exportBlocks(source);
  if (fourSpaceNames.includes(name)) {
    const testingAt = blocks.search(/^ {2}_testing\s*:/m);
    const head = testingAt === -1 ? blocks : blocks.slice(0, testingAt);
    if (new RegExp(`^ {4}${n},\\r?$`, "m").test(head)) return true;
  }
  return new RegExp(`^ {2}(async\\s+)?${n}\\b\\s*(,|:|\\(|\\r?$)`, "m").test(blocks)
    || new RegExp(`^module\\.exports\\.${n}\\s*=`, "m").test(source)
    || new RegExp(`\\w+\\.${n}\\s*=\\s*${n}\\b`, "m").test(source);
}

function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const srcTextCache = new Map();
function readSrcCached(file) {
  let text = srcTextCache.get(file);
  if (text === undefined) {
    text = fs.readFileSync(file, "utf8");
    srcTextCache.set(file, text);
  }
  return text;
}

const INTERNAL_CALLS = Object.freeze({
  "services/starbase/starbaseModuleRuntime.reconcileStarbaseModule": 3,
  "services/starbase/starbaseDefenseRuntime.validateBatteryOperation": 2,
  "services/starbase/starbaseDefenseRuntime.hydrateBatteryActor": 2,
  "services/dynamic/dynamicBountyRuntime.recoverLosses": 2,
  "_secondary/chat/chatRuntime.sendChannelMessage": 2,
});

const WRAP_TOGETHER = Object.freeze({
  "services/dynamic/essRepository": Object.freeze(["read", "write", "mutate"]),
});

function withoutFunctionBodies(source, names) {
  let text = source.replace(/\r\n/g, "\n");
  for (const name of names) {
    const start = new RegExp(`^function ${escapeRe(name)}\\(`, "m").exec(text);
    if (!start) continue;
    const end = text.indexOf("\n}", start.index);
    text = text.slice(0, start.index) + (end === -1 ? "" : text.slice(end + 2));
  }
  return text;
}

function checkWrappedSeam(srcDir, entryPath, name, files = listJs(srcDir)) {
  const problems = [];
  const n = escapeRe(name);
  const file = path.join(srcDir, `${entryPath}.js`);
  if (!fs.existsSync(file)) return [`(a) ${entryPath}: file missing`];
  const source = fs.readFileSync(file, "utf8");
  if (!new RegExp(`^\\s*(async\\s+)?function\\s+${n}\\s*\\(`, "m").test(source)) {
    problems.push(`(a) ${entryPath}: does not declare function ${name} (re-export?)`);
  }
  const together = WRAP_TOGETHER[entryPath];
  if (together && together.includes(name)) {
    const outside = withoutFunctionBodies(source, together);
    const uses = (outside.match(new RegExp(`\\b${n}\\s*\\(`, "g")) || []).length;
    if (uses !== 0) problems.push(`(b) ${entryPath}: ${name}( occurs ${uses} times outside ${together.join("/")}`);
  } else {
    const uses = (source.match(new RegExp(`\\b${n}\\s*\\(`, "g")) || []).length;
    if (uses !== (INTERNAL_CALLS[`${entryPath}.${name}`] || 1)) problems.push(`(b) ${entryPath}: ${name}( occurs ${uses} times (internal call bypasses the wrap)`);
  }
  const base = path.basename(entryPath);
  const destructured = new RegExp(`\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=\\s*require\\(([^;]*?)\\)\\s*;`, "g");
  for (const f of files) {
    const text = readSrcCached(f);
    if (!text.includes(name)) continue;
    if (together && together.includes(name) && !text.includes(base)) continue;
    for (const m of text.matchAll(destructured)) {
      if (!m[1].includes(base)) problems.push(`(c) ${path.relative(srcDir, f)}: destructures ${name} from ${m[1]}`);
    }
  }
  return problems;
}

module.exports = ({ test, skip, bench }) => {
  test("T1 manifest: schema 3 loader fields, id livingNewEden", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(MOD_DIR, "evejs-launcher.mod.json"), "utf8"));
    assert.strictEqual(manifest.schemaVersion, 3);
    assert.strictEqual(manifest.id, "livingNewEden");
    assert.strictEqual(manifest.kind, "loader");
    assert.deepStrictEqual(manifest.supportedBackends, ["native", "docker"]);
    assert.deepStrictEqual(manifest.activation, { strategy: "loader_rename" });
    assert.strictEqual(manifest.restart, "game_server");
    const allowed = ["schemaVersion", "id", "displayName", "version", "description", "kind",
      "supportedBackends", "compatibility", "activation", "restart", "loadAfter", "settings"];
    assert.deepStrictEqual(Object.keys(manifest).filter((k) => !allowed.includes(k)), []);
    assert.ok(Array.isArray(manifest.loadAfter) && manifest.loadAfter.length > 0, "loadAfter lists mods");
    assert.deepStrictEqual(manifest.loadAfter.filter((id) => id === manifest.id
      || !fs.existsSync(path.resolve(MOD_DIR, "..", id))), [], "loadAfter names mods of the collection");
    assert.strictEqual(new Set(manifest.loadAfter).size, manifest.loadAfter.length, "loadAfter has no duplicates");
    assert.deepStrictEqual(Object.keys(manifest.compatibility), ["evejsVersions"]);
    const serverPackage = path.resolve(MOD_DIR, "..", "..", "server", "package.json");
    if (fs.existsSync(serverPackage)) {
      const version = JSON.parse(fs.readFileSync(serverPackage, "utf8")).version;
      assert.ok(manifest.compatibility.evejsVersions.includes(version), `compatibility lists EveJS ${version}`);
    }
  });

  test("C4 config facts: key lists, env names, .env.example, manifest settings match SCHEMA", () => {
    const { SCHEMA, LIMIT_KEYS, MODULE_NAMES, ENV_PREFIX } = require("../../config");
    assert.deepStrictEqual([...LIMIT_KEYS], ["maxVirtualFleets", "maxDueEventsPerPass", "maxSchedulerWorkMs",
      "maxBattleResolutionsPerPass", "maxLiveMaterializationsPerSystem", "maxLiveMaterializationsGlobal",
      "maxNewSitesPerSystemPerWindow", "maxActiveFrontsPerFaction", "maxCatchUpEventsPerPass",
      "maxSovWritesPerWindow", "sovWriteWindowMs"]);
    assert.deepStrictEqual([...MODULE_NAMES].sort(), ["battle", "events", "fleets", "graph", "materialization",
      "persistence", "presence", "scheduler", "sites", "sovProjection", "strategy", "structures", "telemetry",
      "virtualCorps", "world"]);
    const byKey = new Map(SCHEMA.map((row) => [row.key, row]));
    for (const name of LIMIT_KEYS) assert.ok(byKey.has(`limits.${name}`), name);
    for (const name of MODULE_NAMES) assert.ok(byKey.has(`modules.${name}.enabled`), name);
    const envs = SCHEMA.map((row) => row.env);
    assert.ok(envs.every((e) => e.startsWith(ENV_PREFIX)), "env prefix");
    assert.strictEqual(new Set(envs).size, envs.length, "env names unique");
    const example = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    assert.deepStrictEqual(envs.filter((e) => !example.includes(`${e}=`)), [], ".env.example misses env");

    const manifest = JSON.parse(fs.readFileSync(path.join(MOD_DIR, "evejs-launcher.mod.json"), "utf8"));
    const { settings } = manifest;
    assert.strictEqual(settings.schemaVersion, 1);
    const files = new Map(settings.files.map((f) => [f.id, f]));
    const problems = [];
    for (const field of settings.fields) {
      const where = field.id;
      for (const prop of ["id", "label", "description", "group", "type", "default", "restart", "file", "key"]) {
        if (!Object.prototype.hasOwnProperty.call(field, prop)) problems.push(`${where}: no ${prop}`);
      }
      const row = byKey.get(field.id);
      if (!row) { problems.push(`${where}: not in SCHEMA`); continue; }
      if (!row.launcher) problems.push(`${where}: SCHEMA row has no launcher entry`);
      if (field.key.join(".") !== field.id) problems.push(`${where}: key`);
      if (field.type !== row.type || field.default !== row.default) problems.push(`${where}: type/default`);
      if (field.minimum !== row.min || field.maximum !== row.max) problems.push(`${where}: minimum/maximum`);
      if (field.restart !== "game_server") problems.push(`${where}: restart`);
      const file = files.get(field.file);
      if (!file || file.base !== "mod" || file.path !== "settings.json" || file.format !== "json") {
        problems.push(`${where}: file`);
      }
      if (field.group === "Danger" && (field.advanced !== true || field.default !== false)) {
        problems.push(`${where}: Danger must be advanced and off`);
      }
      const l = row.launcher || {};
      if (field.label !== l.label) problems.push(`${where}: label`);
      if (field.description !== `${l.description} Default: ${row.default}.`) problems.push(`${where}: description`);
      if (field.group !== l.group) problems.push(`${where}: group`);
      if (field.advanced !== (l.advanced === true ? true : undefined)) problems.push(`${where}: advanced`);
      const step = l.step !== undefined ? l.step : (row.type === "integer" ? 1 : undefined);
      if (field.step !== step) problems.push(`${where}: step`);
    }
    for (const row of SCHEMA) {
      const danger = row.launcher && row.launcher.group === "Danger";
      if (danger && (row.launcher.advanced !== true || row.default !== false)) {
        problems.push(`${row.key}: SCHEMA Danger must be advanced and off`);
      }
    }
    const ids = settings.fields.map((f) => f.id);
    for (const key of ["enabled", "testing.timeScale", "testing.accelerationEnabled", "observer.host"]) {
      assert.ok(!ids.includes(key), `${key} not in launcher`);
    }
    assert.strictEqual(ids.length, SCHEMA.filter((row) => row.launcher).length, "one field per launcher row");
    assert.deepStrictEqual(problems, []);
  });

  test("T5a vendor facts: role before bootstrap require, bootWorld, mutateState, _processRole, dataRoot (R3)", () => {
    const server = findServerDir();
    assert.ok(server, "EveJS server/ not found above the mod");
    const read = (rel) => fs.readFileSync(path.join(server, rel), "utf8");
    const index = read("index.js");
    const roleAt = index.search(/process\.env\.EVEJS_GAMESTORE_OWNER_ROLE\s*=\s*"world"/);
    const bootAt = index.search(/const\s*\{\s*bootWorld\s*\}\s*=\s*require\([^)]*"\.\/bootstrap"\)/);
    assert.ok(roleAt >= 0, "index.js: role assignment missing");
    assert.ok(bootAt >= 0, "index.js: destructured bootWorld require missing");
    assert.ok(roleAt < bootAt, "index.js: role must be set before bootstrap is required");
    const bootstrap = read("bootstrap.js");
    assert.match(bootstrap, /async function bootWorld\(/);
    assert.match(bootstrap, /module\.exports\s*=\s*\{[^}]*\bbootWorld\b/);
    const wormhole = read(path.join("src", "services", "exploration", "wormholes", "wormholeRuntimeState.js"));
    assert.match(wormhole, /function mutateState\(/);
    assert.match(wormhole, /module\.exports\s*=\s*\{[^}]*\bmutateState,/);
    assert.match(read(path.join("src", "gameStore", "index.js")), /_processRole:\s*PROCESS_ROLE/);

    const dataRootFile = path.join(server, "src", "config", "dataRoot.js");
    const dataRootSource = fs.readFileSync(dataRootFile, "utf8");
    assert.deepStrictEqual([...dataRootSource.matchAll(/\brequire\s*\(([^)]*)\)/g)].map((m) => m[1]), ["\"path\""],
      "dataRoot.js must require only path before the test may load it");
    assert.ok(dataRootSource.includes("env.EVEJS_DATA_ROOT") && dataRootSource.includes("\"_local\""), "dataRoot rule");
    const { resolveDataRoot } = require(dataRootFile);
    const { resolveDataDir } = require("../../config");
    for (const env of [{}, { EVEJS_DATA_ROOT: "  /tmp/lne  " }, { EVEJS_DATA_ROOT: "rel" }]) {
      assert.strictEqual(resolveDataDir(env, MOD_DIR), path.join(resolveDataRoot(env), "mods", "livingNewEden"),
        JSON.stringify(env));
    }
  });

  test("A3 vendor facts GAME_MODULES: files, export blocks, mixin methods, tick sample seam, loader literals", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const problems = [];
    for (const entry of GAME_MODULES) {
      const file = path.join(src, `${entry.path}.js`);
      if (!fs.existsSync(file)) { problems.push(`${entry.path}: file missing`); continue; }
      const source = fs.readFileSync(file, "utf8");
      const mixins = entry.factDir
        ? listJs(path.join(src, entry.factDir)).map((f) => fs.readFileSync(f, "utf8")) : [];
      for (const s of entry.symbols) {
        const n = escapeRe(s.name);
        let ok;
        if (s.kind === "prototypeMethod") {
          const def = new RegExp(`^\\s*(async\\s+)?${n}\\s*\\(`, "m");
          ok = mixins.some((text) => def.test(text));
        } else if (s.kind === "classPrototypeMethod" && s.classExport) {
          const text = source.replace(/\r\n/g, "\n");
          const def = new RegExp(`^( {2})?(async\\s+)?${n}\\s*\\(`, "m");
          ok = new RegExp(`^class ${escapeRe(s.classExport)}\\b`, "m").test(text)
            && exportsName(source, s.classExport, FOUR_SPACE_EXPORTS[entry.path] || [])
            && mixins.some((m) => def.test(m.replace(/\r\n/g, "\n")));
        } else if (s.kind === "classPrototypeMethod") {
          const text = source.replace(/\r\n/g, "\n");
          const cls = /^module\.exports\s*=\s*(\w+);/m.exec(text);
          const def = new RegExp(`^  (async\\s+)?${n}\\s*\\(`, "m");
          ok = Boolean(cls) && new RegExp(`^class ${escapeRe(cls[1])}\\b`, "m").test(text)
            && (def.test(text) || (text.includes("function attachDogmaServiceMethods(")
              && mixins.some((m) => def.test(m.replace(/\r\n/g, "\n")))));
        } else {
          ok = exportsName(source, s.name, FOUR_SPACE_EXPORTS[entry.path] || [])
            || inlineExportsName(source, entry.path, s.name)
            || headLineExportsName(source, entry.path, s.name)
            || mixedLineExportsName(source, entry.path, s.name)
            || spreadExportsName(source, entry.path, s.name)
            || factorySpreadExportsName(source, entry.path, s.name)
            || publishedFacadeName(source, entry.path, s.name)
            || (s.kind === "property" && new RegExp(`this\\.${n}\\s*=`).test(source))
            || ((ASSIGNED_EXPORTS[entry.path] || []).includes(s.name)
              && new RegExp(`^runtimeExports\\.${n}\\s*=`, "m").test(source));
        }
        if (!ok && s.kind === "property" && entry.path === "config/index") {
          ok = source.includes("createConfigManager(") && listJs(path.join(src, "config", "schema"))
            .some((f) => fs.readFileSync(f, "utf8").includes(`"key": "${s.name}"`));
        }
        if (!ok) problems.push(`${entry.path}.${s.name} (${s.kind})`);
      }
    }
    assert.deepStrictEqual(problems, []);

    const tick = fs.readFileSync(path.join(src, "space", "runtime", "spaceRuntime", "tick.js"), "utf8");
    assert.ok(tick.includes("tidiAutoscaler.observeRuntimeTickSample("), "tick.js calls through the module object");
    const destructured = /\{[^}]*\bobserveRuntimeTickSample\b[^}]*\}\s*=/;
    const offenders = [...listJs(path.join(src, "space")), ...listJs(path.join(src, "utils"))]
      .filter((f) => destructured.test(readSrcCached(f)));
    assert.deepStrictEqual(offenders, [], "observeRuntimeTickSample destructured - a wrap would be bypassed");
    const runtime = fs.readFileSync(path.join(src, "space", "runtime.js"), "utf8");
    assert.ok(runtime.includes("Object.setPrototypeOf(runtimeExports") && runtime.includes("writable: true"));

    const names = (p) => (GAME_MODULES.find((e) => e.path === p) || { symbols: [] }).symbols.map((s) => s.name);
    assert.ok(names("services/exploration/wormholes/wormholeRuntimeState").includes("mutateState"));
    assert.ok(names("../bootstrap").includes("bootWorld") && names("../bootstrap").includes("PRODUCTION_STAGES"));
    const loaderSource = fs.readFileSync(path.join(MOD_DIR, "loader.js"), "utf8");
    for (const literal of ["\"wormholeRuntimeState\"", "\"mutateState\"", "\"bootWorld\"", "\"PRODUCTION_STAGES\""]) {
      assert.ok(loaderSource.includes(literal), `loader.js literal ${literal}`);
    }
    const all = GAME_MODULES.flatMap((e) => e.symbols.map((s) => s.name));
    for (const dead of ["getLastRuntimeTickSummary", "_lastTickSummary", "_recentTickSummaries"]) {
      assert.ok(!all.includes(dead), `${dead} is dead on the export`);
    }
    assert.strictEqual(new Set(GAME_MODULES.map((e) => e.path)).size, 159, "159 paths");
  });

  const P2_FAST_SCAN_DIRS = ["space", path.join("services", "character"), path.join("services", "contracts"),
    path.join("services", "exploration"),
    path.join("_secondary", "chat"), path.join("services", "chat"),
    path.join("services", "dungeon"),
    path.join("services", "fighter"),
    path.join("services", "sovereignty"), path.join("services", "scheduler"),
    path.join("services", "starbase"), path.join("services", "dogma"), path.join("services", "inventory"),
    path.join("services", "planet"), path.join("services", "ship"),
    path.join("services", "mining"), path.join("services", "drone"),
    path.join("services", "dynamic"), path.join("services", "bounty"), path.join("services", "killmail"),
    path.join("services", "incursion"), path.join("services", "map"),
    path.join("services", "mail"),
    path.join("services", "homefront"),
    path.join("services", "market")];
  const p2 = (full) => () => {
      const src = findSrcDir();
      assert.ok(src, "EveJS server/src not found above the mod");
      const wrapped = GAME_MODULES.flatMap((e) => e.symbols
        .filter((s) => s.wrap === true && s.kind !== "classPrototypeMethod" && s.kind !== "prototypeMethod")
        .map((s) => ({ path: e.path, name: s.name })));
      assert.deepStrictEqual(wrapped.map((w) => `${w.path}.${w.name}`), [
        "services/incursion/incursionRuntime.listActiveIncursions",
        "services/incursion/incursionFocusPlacement.selectPlacement",
        "services/incursion/incursionSystemEffects.shipModifiers",
        "services/incursion/incursionSystemEffects.bountyMultiplier",
        "services/incursion/incursionSystemEffects.blocksCyno",
        "services/map/mapTelemetryState.listJumpHistoryRows",
        "services/mining/miningLedgerState.recordMiningLedgerEvent",
        "services/mining/miningRuntime.executeMiningCycle",
        "utils/tidiAutoscaler.observeRuntimeTickSample",
        "services/exploration/signatures/providers/sceneAnomalySiteProvider.listAnomalySites",
        "services/exploration/probes/probeScanRuntime.buildSignatureScanResults",
        "_secondary/chat/chatRuntime.broadcastLocalMessage",
        "_secondary/chat/chatRuntime.sendChannelMessage",
        "services/dungeon/dungeonTrackingRuntime.enterDungeonRoomForSession",
        "services/dungeon/dungeonTrackingRuntime.notifyDungeonCompletedForScene",
        "services/dungeon/dungeonTrackingRuntime.recordAbyssalRunCompletion",
        "services/mail/mailNotifications.sendMailSentNotification",
        "space/npc/pirateFactionPolicy.resolvePirateFactionKeyForSystem",
        "space/npc/capitals/capitalNpcCatalog.getCapitalNpcGeneratedRows",
        "services/fighter/npc/npcSupercarrierDirector.syncNpcSupercarrierSystems",
        "space/npc/capitals/capitalNpcMovement.syncCapitalNpcMovement",
        "services/dungeon/dungeonSiteSpawnPolicy.buildRuntimeSystemPolicyContext",
        "space/npc/beltRatRuntime.maybeSpawnForSessionArrival",
        "services/character/factionKillStandingRuntime.recordNpcFactionStandingLoss",
        "services/sovereignty/sovPlayerDeployment.deployStructureFromInventoryItem",
        "services/sovereignty/sovCampaignState.bindDurableScheduler",
        "services/sovereignty/sovCampaignState.unbindDurableScheduler",
        "services/sovereignty/sovModernState.getHubUpgrades",
        "services/dynamic/essRepository.read",
        "services/dynamic/essRepository.write",
        "services/dynamic/essRepository.mutate",
        "services/dynamic/essSettlementRuntime.handleJob",
        "services/dynamic/essSettlementRuntime.reconcile",
        "services/dynamic/dynamicBountyRuntime.maintain",
        "services/dynamic/dynamicBountyRuntime.recoverLosses",
        "services/contracts/contractNotifications.notifyContractAccepted",
        "services/market/marketRules.getMarketContext",
        "services/starbase/starbaseModuleRuntime.startAnchorTransition",
        "services/starbase/starbaseModuleRuntime.reconcileStarbaseModule",
        "services/starbase/starbaseModuleRuntime.setOnlineState",
        "services/starbase/starbaseDefenseRuntime.validateBatteryOperation",
        "services/starbase/starbaseDefenseRuntime.hydrateBatteryActor",
        "services/starbase/starbaseInventoryRuntime.validateBatteryAmmoInventoryAccess",
        "space/transitions.boardSpaceShip",
      ]);
      const allFiles = full ? listJs(src) : P2_FAST_SCAN_DIRS.flatMap((d) => listJs(path.join(src, d)));
      for (const w of wrapped) assert.deepStrictEqual(checkWrappedSeam(src, w.path, w.name, allFiles), [], w.name);
      const old = checkWrappedSeam(src, "space/npc/beltRatRuntime", "resolvePirateFactionKeyForSystem", allFiles);
      assert.ok(old.some((p) => p.startsWith("(a)")), JSON.stringify(old));
      for (const dead of ["chooseStandardPoolProfileIDForFactionHull", "resolveConcretePirateFactionKey"]) {
        const found = checkWrappedSeam(src, "space/npc/beltRatRuntime", dead, allFiles);
        assert.ok(found.some((p) => p.startsWith("(b)")), `${dead}: ${JSON.stringify(found)}`);
      }
      const belt = fs.readFileSync(path.join(src, "space", "npc", "beltRatRuntime.js"), "utf8");
      assert.ok(belt.includes("resolvePirateFactionKeyForSystem(systemID"), "beltRatRuntime still calls the seam");
      const loaderSource = fs.readFileSync(path.join(MOD_DIR, "loader.js"), "utf8");
      assert.ok(loaderSource.includes("\"pirateFactionPolicy\""), "loader.js literal \"pirateFactionPolicy\"");
      assert.ok(loaderSource.includes("\"beltRatRuntime\""), "loader.js literal \"beltRatRuntime\"");
    };
  test("P2 vendor facts: every wrap:true seam is the definer, not called inside, not re-exported "
    + "(c) in the definer trees", p2(false));
  bench("P2full vendor facts: (c) no seam destructured from a re-exporter anywhere in server/src",
    p2(true));

  test("F1 vendor facts: worldData cache fields, wormhole ID range of pirateFactionPolicy", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const worldData = fs.readFileSync(path.join(src, "space", "worldData.js"), "utf8");
    const buildMaps = worldData.slice(worldData.indexOf("function buildMaps("));
    const returned = buildMaps.slice(buildMaps.search(/^ {2}return \{/m));
    const block = returned.slice(0, returned.search(/^ {2}\};/m));
    for (const field of ["solarSystems", "stargates", "stations"]) {
      assert.ok(new RegExp(`^ {4}${field},\\r?$`, "m").test(block), `buildMaps returns ${field}`);
    }
    const policy = fs.readFileSync(path.join(src, "space", "npc", "pirateFactionPolicy.js"), "utf8");
    const fn = policy.slice(policy.indexOf("function isWormholeSpaceSystem("));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.ok(body.includes(">= 31_000_000") && body.includes("<= 31_999_999"), "WH range 31000000..31999999");
    const { SYSTEM_ID_SPACES } = require("../../lib/adapter/staticMapData");
    assert.deepStrictEqual({ ...SYSTEM_ID_SPACES.wormhole }, { min: 31000000, max: 31999999 });
  });

  test("F4 vendor facts: worldData.getStationByID by stationID, station row fields used by EveJS", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const worldData = fs.readFileSync(path.join(src, "space", "worldData.js"), "utf8");
    assert.ok(exportsName(worldData, "getStationByID"), "getStationByID exported");
    assert.match(worldData, /stationsById\.set\(station\.stationID, station\)/);
    assert.match(worldData, /stationsBySystem\.has\(station\.solarSystemID\)/);
    assert.match(worldData, /station\.corporationID/);
    assert.match(worldData, /function getStationByID\(stationID\) \{\s+return ensureLoaded\(\)\.stationsById\.get/);
    const charMgr = fs.readFileSync(path.join(src, "services", "character", "charMgrService.js"), "utf8");
    assert.ok(charMgr.includes("station.stationTypeID"), "stationTypeID");
    const geometry = fs.readFileSync(path.join(src, "services", "station", "stationLocatorGeometry.js"), "utf8");
    assert.ok(geometry.includes("station.position"), "position");
    const transitions = fs.readFileSync(path.join(src, "space", "transitions.js"), "utf8");
    assert.ok(transitions.includes("stationName"), "stationName");
    const { readNpcStationsFrom } = require("../../lib/adapter/npcStations");
    const fixture = { getStationByID: (id) => (id === 60014284 ? { stationID: id, solarSystemID: 30001868,
      corporationID: 1000162, stationTypeID: 1529, stationName: "37S-KO - True Power", position: { x: 1, y: 2, z: 3 } }
      : null) };
    const r = readNpcStationsFrom(fixture, [60014284, 1]);
    assert.ok(r.ok);
    assert.deepStrictEqual({ ...r.stations.get(60014284) }, { stationId: 60014284, systemId: 30001868,
      corporationId: 1000162, typeId: 1529, name: "37S-KO - True Power", position: { x: 1, y: 2, z: 3 } });
    assert.strictEqual(r.stations.has(1), false, "a missing station is left out");
    assert.strictEqual(readNpcStationsFrom({}, [1]).reason, "WORLD_DATA_DRIFT");
  });

  test("HSA-F hunt-sweep-anomalies vendor facts: listSystemAnomalySites(systemID, options = {}) exported, a "
    + "scene is loaded only on loadScene/materializeScene, both anomaly providers set actualPosition", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const sig = path.join(src, "services", "exploration", "signatures");
    const read = (...p) => fs.readFileSync(path.join(sig, ...p), "utf8").replace(/\r\n/g, "\n");
    const runtime = read("signatureRuntime.js");
    assert.ok(runtime.includes("function listSystemAnomalySites(systemID, options = {})"), "listSystemAnomalySites");
    assert.ok(exportsName(runtime, "listSystemAnomalySites"), "listSystemAnomalySites exported");
    assert.match(read("providers", "sceneProviderRuntime.js"),
      /function shouldLoadScene\(options = \{\}\) \{\s+return options && \(\s+options\.loadScene === true \|\|\s+options\.materializeScene === true\s+\);/);
    assert.ok(read("providers", "sceneAnomalySiteProvider.js").includes("actualPosition: {"), "scene provider position");
    assert.ok(read("providers", "miningAnomalyProvider.js").includes("actualPosition: cloneVector(entity && entity.position)"),
      "mining provider position");
  });

  test("TS5 vendor facts: structure seam (exports, devFlags kept, null -> 0, frozen clock, listener, destroy "
    + "once, remove NOT_EMPTY, placement R2, states, types)", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const read = (...p) => fs.readFileSync(path.join(src, ...p), "utf8");
    const body = (source, name) => {
      const start = source.search(new RegExp(`^function ${escapeRe(name)}\\(`, "m"));
      assert.ok(start >= 0, `${name} declared`);
      const rest = source.slice(start);
      return rest.slice(0, rest.search(/^\}/m));
    };
    const state = read("services", "structure", "structureState.js");
    const { REQUIRED_FUNCTIONS } = require("../../lib/adapter/structures");
    const fourSpace = FOUR_SPACE_EXPORTS["services/structure/structureState"];
    for (const name of [...REQUIRED_FUNCTIONS.state, "STRUCTURES_TABLE"]) {
      assert.ok(exportsName(state, name, fourSpace), `structureState.${name} exported`);
    }
    assert.strictEqual(exportsName(state, "registerStructureChangeListener"), false,
      "without the explicit list a four-space entry does not count");
    assert.strictEqual(exportsName(state, "normalizeStructureRecord", fourSpace), false, "_testing does not count");

    assert.ok(body(state, "normalizeStructureRecord").includes("devFlags: entry.devFlags && typeof entry.devFlags "
      + "=== \"object\" ? cloneValue(entry.devFlags) : {}"), "devFlags kept by every write");
    for (const field of ["stateEndsAt", "destroyedAt"]) {
      assert.ok(body(state, "normalizeStructureRecord").includes(`${field}: Number.isFinite(Number(entry.${field})) `
        + `? toInt(entry.${field}, 0) : null,`), `${field} normalized null -> 0`);
    }
    assert.ok(body(state, "toInt").includes("Number.isFinite(numeric) ? Math.trunc(numeric) : fallback"), "toInt");
    assert.ok(body(state, "updateStructureRecord").includes("updater(cloneValue(current))"), "updater gets a clone");
    for (const name of ["getStructureByID", "listStructures"]) {
      assert.ok(body(state, name).includes("options.refresh !== false"), `${name} refresh:false skips the tick`);
    }
    const advance = body(state, "maybeAdvanceStructureState");
    const anchoring = advance.indexOf("structure.state === STRUCTURE_STATE.ANCHORING");
    const guard = advance.indexOf("return { structure, changed: false };");
    assert.ok(anchoring >= 0 && guard > anchoring, "ANCHORING exception before the frozen-clock guard");
    assert.ok(advance.slice(anchoring, guard).split("structure.stateEndsAt === null").length - 1 === 2,
      "stateEndsAt === null: exception of ANCHORING and the guard");
    const persist = body(state, "persistStructures");
    assert.ok(persist.includes("options.emitLive !== false") && persist.includes(
      "notifyStructureChangeListeners(previousRows, cachedRows)"), "listeners called inside persistStructures");
    assert.match(body(state, "notifyStructureChangeListeners"), /try \{\s+listener\(payload\);\s+\} catch/);
    assert.match(body(state, "registerStructureChangeListener"),
      /return \(\) => \{\s+structureChangeListeners\.delete/);
    assert.ok(body(state, "destroyStructure").includes("if (!current.destroyedAt) {"), "destroy effects only once");
    const remove = body(state, "removeStructure");
    assert.ok(remove.includes("\"STRUCTURE_NOT_EMPTY\"") && remove.includes("options.discardContents === true"));
    assert.match(state, /^const STRUCTURES_TABLE = "structures";/m);
    const { CONDITION_FULL, CONDITION_ARMOR_STAGE, CONDITION_HULL_STAGE } =
      require("../../lib/stations/structures/schema");
    const frozen = (name, value) => new RegExp(`^const ${name} = Object\\.freeze\\(\\{\\s*`
      + Object.entries(value).map(([k, v]) => `${k}: ${v},`).join("\\s*") + "\\s*\\}\\);", "m");
    assert.match(state, frozen("STRUCTURE_ARMOR_STAGE_CONDITION", CONDITION_ARMOR_STAGE));
    assert.match(state, frozen("STRUCTURE_HULL_STAGE_CONDITION", CONDITION_HULL_STAGE));
    const condition = body(state, "normalizeConditionState");
    for (const [k, v] of Object.entries(CONDITION_FULL)) {
      const text = typeof v === "boolean" ? `${k}: Boolean(source.${k})` : `${k}: clamp01(source.${k}, ${v})`;
      assert.ok(condition.includes(text) && (typeof v !== "boolean" || v === false), text);
    }

    const constantsFile = path.join(src, "services", "structure", "structureConstants.js");
    assert.ok(!/\brequire\s*\(/.test(fs.readFileSync(constantsFile, "utf8")), "structureConstants requires nothing");
    const constants = require(constantsFile);
    assert.deepStrictEqual([2, 102, 110, 111, 112, 113, 114, 115], ["ANCHORING", "ONLINING_VULNERABLE",
      "SHIELD_VULNERABLE", "ARMOR_REINFORCE", "ARMOR_VULNERABLE", "HULL_REINFORCE", "HULL_VULNERABLE",
      "ANCHOR_VULNERABLE"].map((n) => constants.STRUCTURE_STATE[n]));
    for (const s of [113, 114, 115]) assert.ok(constants.STRUCTURE_DISABLED_STATES.has(s), `disabled ${s}`);
    const { readStructureStatesFrom } = require("../../lib/adapter/structures");
    const states = readStructureStatesFrom({ constants });
    assert.deepStrictEqual([states.ok, states.states.ANCHOR_VULNERABLE, states.upkeep.FULL_POWER], [true, 115, 1]);
    const { STRUCTURE_TYPE_IDS } = require("../../lib/stations/data/structureTypes");
    const typeIds = Object.values(STRUCTURE_TYPE_IDS).sort((a, b) => a - b);
    assert.deepStrictEqual(typeIds, [35825, 35826, 35827, 35832, 35833, 35834, 35835, 35836]);
    for (const id of typeIds) {
      assert.strictEqual((constants.STRUCTURE_TYPE_PRESETS[id] || {}).typeID, id, `type ${id} in structureConstants`);
    }

    const placement = read("services", "structure", "structureDeploymentPlacement.js");
    const validate = body(placement, "validateDeploymentPlacement");
    assert.ok(validate.includes("{ solarSystemID, typeID, position, offset, scene }")
      && validate.includes("errorMsg: \"DEPLOYMENT_CONFLICT\""), "validateDeploymentPlacement shape");
    assert.match(placement, /getStructureState\(\)\.listStructuresForSystem\(systemID\)\./);
    const worldData = read("space", "worldData.js");
    assert.match(worldData, new RegExp("for \\(const value of celestialsBySystem\\.values\\(\\)\\) \\{\\s+"
      + "value\\.sort\\(\\(left, right\\) => left\\.itemID - right\\.itemID\\);"), "celestials sorted by itemID");
    assert.match(read("gameStore", "index.js"), /^function flushTableSync\(table, options = \{\}\) \{/m);
    assert.ok(read("space", "runtime.js").includes("\"../services/structure/structureState\""),
      "structureState in require.cache after boot");
  });

  test("F1 vendor facts: buildWalletRef forCorp returns corporation kind and getSessionCorpAccountKey", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const contractRuntime = fs.readFileSync(path.join(src, "services", "contracts", "contractRuntimeState.js"), "utf8");
    const body = contractRuntime.slice(contractRuntime.indexOf("function buildWalletRef("));
    const fnBody = body.slice(0, body.search(/^\}/m));
    assert.ok(fnBody.includes('kind: "corporation"'), "buildWalletRef returns kind corporation for forCorp");
    assert.ok(fnBody.includes("getSessionCorpAccountKey(session)"), "buildWalletRef uses getSessionCorpAccountKey");
    const prepareBody = contractRuntime.slice(contractRuntime.indexOf("function prepareContractCreationRequest("));
    const prepareFnBody = prepareBody.slice(0, prepareBody.search(/^\}/m));
    assert.ok(prepareFnBody.includes("info.forCorp && !sessionHasCorpContractManagerRole(session)"),
      "prepareContractCreationRequest checks the role for forCorp");
    const roleBody = contractRuntime.slice(contractRuntime.indexOf("function sessionHasCorpContractManagerRole("));
    assert.match(roleBody.slice(0, roleBody.search(/^\}/m)), /^\s+const \{ getPersistedCorporationAuthority, corporationAuthorityHasRole \} = require\("\.\.\/corporation\/corporationAuthority"\);\r?\n\s+return corporationAuthorityHasRole\(getPersistedCorporationAuthority\(session\), CORP_ROLE_CONTRACT_MANAGER\);/m,
      "sessionHasCorpContractManagerRole reads the persisted authority at call time");
    const authorityRequires = contractRuntime.split(/\r?\n/).filter((l) => l.includes('require("../corporation/corporationAuthority")'));
    assert.ok(authorityRequires.length >= 4 && authorityRequires.every((l) => /^\s{2,}const \{/.test(l)),
      "contractRuntimeState requires corporationAuthority only inside functions");
    const authority = fs.readFileSync(path.join(src, "services", "corporation", "corporationAuthority.js"), "utf8");
    const persisted = authority.slice(authority.indexOf("function getPersistedCorporationAuthority("));
    const persistedBody = persisted.slice(0, persisted.search(/^\}/m));
    assert.ok(persistedBody.includes("corporation.isNPC !== false") && persistedBody.includes("isNpcCorporationID(corporationID)"),
      "the persisted authority is null for an NPC corporation (the reason of the wrap)");
    assert.ok(/isDirector:\s*\r?\n?\s*\(sessionCorporationRoles & CORP_ROLE_DIRECTOR\)/.test(persistedBody)
      && /if \(authority\.isDirector\) \{\s*return true;/.test(authority), "isDirector grants every role");
    assert.match(authority, /^\s+getPersistedCorporationAuthority,\r?$/m, "getPersistedCorporationAuthority exported");
    assert.ok(/^const CORP_ROLE_CONTRACT_MANAGER = \d+n;/m.test(contractRuntime), "role mask is a BigInt literal");
    assert.ok(/^\s+CORP_ROLE_CONTRACT_MANAGER,\r?$/m.test(contractRuntime), "role mask exported");
  });

  test("F2 vendor facts: prepareContractCreationRequest calls findPendingContractSettlement before ensureWalletFunds", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const contractRuntime = fs.readFileSync(path.join(src, "services", "contracts", "contractRuntimeState.js"), "utf8");
    const prepareBody = contractRuntime.slice(contractRuntime.indexOf("function prepareContractCreationRequest("));
    const fnBody = prepareBody.slice(0, prepareBody.search(/^\}/m));
    const pendingIdx = fnBody.indexOf("findPendingContractSettlement");
    const walletIdx = fnBody.indexOf("ensureWalletFunds");
    assert.ok(pendingIdx >= 0, "findPendingContractSettlement called");
    assert.ok(walletIdx >= 0, "ensureWalletFunds called");
    assert.ok(pendingIdx < walletIdx, "findPendingContractSettlement before ensureWalletFunds");
  });

  test("F3 vendor facts: getOwnerDeliveryFlag returns CORP_DELIVERIES (62) for forCorp; default HANGAR", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const contractRuntime = fs.readFileSync(path.join(src, "services", "contracts", "contractRuntimeState.js"), "utf8");
    const fnBody = contractRuntime.slice(contractRuntime.indexOf("function getOwnerDeliveryFlag("))
    const body = fnBody.slice(0, fnBody.search(/^\}/m));
    assert.ok(body.includes("ITEM_FLAGS.CORP_DELIVERIES"), "getOwnerDeliveryFlag uses CORP_DELIVERIES");
    const itemStore = fs.readFileSync(path.join(src, "services", "inventory", "itemStore.js"), "utf8");
    assert.ok(/CORP_DELIVERIES:\s*62/.test(itemStore), "CORP_DELIVERIES is 62 in itemStore");
    assert.ok(body.includes("ITEM_FLAGS.HANGAR"), "default startStationDivision is HANGAR");
  });

  test("F4 vendor facts: deleteContract checks isIssuedBySessionWithCorpAuthority and OUTSTANDING/REJECTED statuses", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const contractRuntime = fs.readFileSync(path.join(src, "services", "contracts", "contractRuntimeState.js"), "utf8");
    const fnBody = contractRuntime.slice(contractRuntime.indexOf("function prepareContractTerminalRequest("));
    const body = fnBody.slice(0, fnBody.search(/^\}/m));
    assert.ok(body.includes("isIssuedBySessionWithCorpAuthority"), "prepareContractTerminalRequest checks corp authority for delete");
    assert.ok(body.includes("CONTRACT_STATUS.OUTSTANDING") && body.includes("CONTRACT_STATUS.REJECTED"), "delete allows OUTSTANDING/REJECTED");
    assert.ok(contractRuntime.includes("CONTRACT_STATUS.DELETED"), "terminal record has DELETED status");
  });

  test("F5 vendor facts: walletAuthorityTransport uses metadata.commandID || crypto.randomUUID; MAX_RECEIPTS=1024", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const walletAuth = fs.readFileSync(path.join(src, "services", "account", "walletAuthorityTransport.js"), "utf8");
    assert.ok(walletAuth.includes("metadata.commandID") && walletAuth.includes("crypto.randomUUID"), "commandID fallback to randomUUID");
    const receiptState = fs.readFileSync(path.join(src, "services", "account", "walletAuthorityReceiptState.js"), "utf8");
    assert.ok(receiptState.includes("MAX_RECEIPTS") && receiptState.includes("1024"), "MAX_RECEIPTS = 1024");
    assert.ok(receiptState.includes("getCorporationRuntime"), "targetExists uses getCorporationRuntime");
  });

  test("F6 vendor facts: INDUSTRY_MATERIAL_COMMIT in DURABLE_LOCAL_MOVE_REASONS and local-remove route", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const itemCustody = fs.readFileSync(path.join(src, "services", "inventory", "itemCustody.js"), "utf8");
    assert.ok(itemCustody.includes("DURABLE_LOCAL_MOVE_REASONS") && itemCustody.includes("INDUSTRY_MATERIAL_COMMIT"), "INDUSTRY_MATERIAL_COMMIT in DURABLE_LOCAL_MOVE_REASONS");
    assert.ok(itemCustody.includes('route === "local-remove"'), "local-remove route branch exists");
  });

  test("F7 vendor facts: contractRuntimeState requires contractNotifications and calls notifyContractAccepted", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const contractRuntime = fs.readFileSync(path.join(src, "services", "contracts", "contractRuntimeState.js"), "utf8");
    assert.ok(contractRuntime.includes('require("./contractNotifications")'), "requires contractNotifications");
    assert.ok(contractRuntime.includes("contractNotifications.notifyContractAccepted("), "calls notifyContractAccepted");
  });

  test("F8 vendor facts: no destructuring of key contract symbols in server/src", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const files = listJs(src);
    const symbols = ["createContract", "getContractRecord", "deleteContract", "listContractRecords", "notifyContractAccepted"];
    const destructured = /\{[^}]*\b(?:createContract|getContractRecord|deleteContract|listContractRecords|notifyContractAccepted)\b[^}]*\}\s*=\s*require\(/;
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      if (destructured.test(text)) {
        for (const sym of symbols) {
          const re = new RegExp(`\\{[^}]*\\b${sym}\\b[^}]*\\}\\s*=\\s*require\\(`);
          if (re.test(text)) {
            assert.fail(`${path.relative(src, f)}: destructures ${sym} from require`);
          }
        }
      }
    }
  });

  test("F9 vendor facts: marketProxyService GetRegionBest returns best_ask_price/type_id; GetOrders returns buys/sells with price", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const marketProxy = fs.readFileSync(path.join(src, "services", "market", "marketProxyService.js"), "utf8");
    assert.ok(marketProxy.includes("best_ask_price"), "GetRegionBest response has best_ask_price");
    assert.ok(marketProxy.includes("type_id"), "GetRegionBest response has type_id");
    assert.ok(marketProxy.includes("GetOrders"), "GetOrders method exists");
    assert.ok(marketProxy.includes(".buys") && marketProxy.includes(".sells") && marketProxy.includes(".price"), "GetOrders returns buys/sells with price");
  });

  test("F10 vendor facts: bootWorld creates production scheduler and wallet authority runtimes", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const serverRoot = path.dirname(src);
    const bootstrap = fs.readFileSync(path.join(serverRoot, "bootstrap.js"), "utf8");
    assert.ok(bootstrap.includes("createProductionSchedulerRuntime"), "bootWorld calls createProductionSchedulerRuntime");
    assert.ok(bootstrap.includes("createProductionWalletAuthorityRuntime"), "bootWorld calls createProductionWalletAuthorityRuntime");
  });

  test("F11 vendor facts: contractNotifications exports literal with notifyContractAccepted; gameModules wrap:true", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const cnPath = path.join(src, "services", "contracts", "contractNotifications.js");
    assert.ok(fs.existsSync(cnPath), "contractNotifications.js exists");
    const source = fs.readFileSync(cnPath, "utf8");
    assert.ok(exportsName(source, "notifyContractAccepted"), "notifyContractAccepted in module.exports literal");
    const files = listJs(src);
    const destructured = /\{[^}]*\bnotifyContractAccepted\b[^}]*\}\s*=\s*require\(/;
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      assert.ok(!destructured.test(text), `${path.relative(src, f)}: destructures notifyContractAccepted from require`);
    }
    assert.ok(source.includes("notifyContractAccepted"), "notifyContractAccepted defined in contractNotifications");
    assert.ok(/function notifyContractAccepted\(contract\b/.test(source), "notifyContractAccepted(contract, sourceSession)");
    const runtime = fs.readFileSync(path.join(src, "services", "contracts", "contractRuntimeState.js"), "utf8");
    assert.ok(runtime.includes("contractNotifications.notifyContractAccepted(next,"), "called with the accepted record `next`");
    assert.ok(/description:\s*normalizeText\(source\.description/.test(runtime), "contract records carry description");
    const gm = GAME_MODULES.find((e) => e.path === "services/contracts/contractNotifications");
    assert.ok(gm, "contractNotifications in GAME_MODULES");
    const sym = gm.symbols.find((s) => s.name === "notifyContractAccepted");
    assert.ok(sym, "notifyContractAccepted symbol in gameModules");
    assert.strictEqual(sym.wrap, true, "wrap: true");
    assert.deepStrictEqual(sym.consumers, ["trade", "freeCorpsContracts", "freeCorpsCouriers"],
      'consumers ["trade", "freeCorpsContracts", "freeCorpsCouriers"]');
  });

  test("F12 vendor facts: corp wallet has only divisions (no wallet.balance); corpWalletState exports division readers", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const walletSrc = fs.readFileSync(path.join(src, "services", "corporation", "corpWalletState.js"), "utf8");
    for (const name of ["getCorporationWallet", "getCorporationWalletBalance", "getCorporationWalletDivision"]) {
      assert.ok(exportsName(walletSrc, name), `corpWalletState exports ${name}`);
    }
    assert.ok(/wallet\.divisions\[String\(normalizedKey\)\]/.test(walletSrc), "division read from wallet.divisions[String(key)]");
    const runtimeSrc = fs.readFileSync(path.join(src, "services", "corporation", "corporationRuntimeState.js"), "utf8");
    const at = runtimeSrc.indexOf("const wallet = {");
    assert.ok(at >= 0, "corporationRuntimeState builds const wallet = {");
    const literal = runtimeSrc.slice(at, runtimeSrc.indexOf("};", at));
    assert.ok(/\bdivisions\s*:/.test(literal), "wallet literal has divisions");
    assert.ok(!/^\s*balance\s*:/m.test(literal), "wallet literal has no top-level balance");
  });

  test("F13 vendor facts merge check: rejected / alreadySettled create shapes, DEFINITIVE_WALLET_ERRORS issuer codes, fingerprintMismatch receipt", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const contractRuntime = fs.readFileSync(path.join(src, "services", "contracts", "contractRuntimeState.js"), "utf8");
    assert.ok(contractRuntime.includes("{ success: true, rejected: true, errorMsg, contractIDs: [] }"), "rejected create saga shape");
    assert.ok(contractRuntime.includes("alreadySettled: true, contractIDs: [] }"), "vanished create saga shape");
    const at = contractRuntime.indexOf("const DEFINITIVE_WALLET_ERRORS = new Set([");
    assert.ok(at >= 0, "DEFINITIVE_WALLET_ERRORS set");
    const set = contractRuntime.slice(at, contractRuntime.indexOf("]);", at));
    assert.ok(set.includes('"CORPORATION_NOT_FOUND"') && set.includes('"CHARACTER_NOT_FOUND"'), "issuer-missing codes are definitive");
    const receipts = fs.readFileSync(path.join(src, "services", "account", "walletAuthorityReceiptState.js"), "utf8");
    assert.ok(receipts.includes("fingerprintMismatch: true,"), "receipt replay flags fingerprintMismatch");
  });

  test("F15 vendor facts: character wallet adjust + receipt codes, buildWalletRef character accountKey 1000, getOwnerDeliveryFlag HANGAR, MAX_WALLET_BALANCE", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const wallet = fs.readFileSync(path.join(src, "services", "account", "walletState.js"), "utf8");
    assert.ok(wallet.includes("function adjustCharacterBalanceAsync(charId, amount, options = {}, metadata = {})"), "adjustCharacterBalanceAsync(charId, amount, options, metadata)");
    assert.ok(exportsName(wallet, "adjustCharacterBalanceAsync") && exportsName(wallet, "getCharacterWallet"), "walletState exports both");
    assert.ok(wallet.includes('errorMsg: "IDEMPOTENCY_KEY_REUSED"'), "IDEMPOTENCY_KEY_REUSED");
    assert.ok(wallet.includes('errorMsg: "CHARACTER_NOT_FOUND"'), "CHARACTER_NOT_FOUND");
    assert.ok(wallet.includes("MAX_WALLET_OPERATION_RECEIPTS = 512"), "512 receipts per character record");
    assert.ok(/GM_CASH_TRANSFER:\s*3,/.test(wallet), "GM_CASH_TRANSFER = 3");
    const contractRuntime = fs.readFileSync(path.join(src, "services", "contracts", "contractRuntimeState.js"), "utf8");
    const ref = contractRuntime.slice(contractRuntime.indexOf("function buildWalletRef("));
    const refBody = ref.slice(0, ref.indexOf("\n}\n"));
    assert.ok(refBody.includes('kind: "character",') && refBody.includes("accountKey: 1000,"), "character wallet ref accountKey 1000");
    const flag = contractRuntime.slice(contractRuntime.indexOf("function getOwnerDeliveryFlag("));
    const flagBody = flag.slice(0, flag.indexOf("\n}\n"));
    assert.ok(flagBody.includes("return forCorp ? ITEM_FLAGS.CORP_DELIVERIES : ITEM_FLAGS.HANGAR;"),
      "forCorp:false delivers to HANGAR");
    const limit = fs.readFileSync(path.join(src, "services", "account", "walletBalanceLimit.js"), "utf8");
    const m = limit.match(/const MAX_WALLET_BALANCE = ([\d_]+);/);
    assert.ok(m && m[1] === "10_000_000_000_000", "MAX_WALLET_BALANCE literal");
    const { MAX_CHARACTER_BALANCE, CHARACTER_ACCOUNT_KEY } = require("../../lib/adapter/tradeContracts");
    assert.strictEqual(MAX_CHARACTER_BALANCE, Number(m[1].replace(/_/g, "")), "mod limit = vendor limit");
    assert.strictEqual(CHARACTER_ACCOUNT_KEY, 1000);
  });

  test("F14 vendor facts merge check: deleteContract returns boolean, escrow refund to record.issuerWallet, only the issuer deletes, issuerWallet = cloneWalletRef", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const contractRuntime = fs.readFileSync(path.join(src, "services", "contracts", "contractRuntimeState.js"), "utf8");
    const del = contractRuntime.slice(contractRuntime.indexOf("async function deleteContract("));
    const delBody = del.slice(0, del.indexOf("\n}\n"));
    assert.ok(delBody.includes("return Boolean(result && result.success);"), "deleteContract -> Promise<boolean>");
    assert.ok(delBody.includes('throwContractError("Another contract operation is already pending.");'), "pending -> exception");
    assert.ok(/legID: "delete:reward-refund",\r?\n\s*ref: contract\.issuerWallet,/.test(contractRuntime), "delete refunds escrow to record.issuerWallet");
    assert.ok(contractRuntime.includes('throwContractError("Only the issuer can delete this contract.");'), "non-issuer delete throws");
    assert.ok(contractRuntime.includes("toPositiveInteger(contract.issuerID, 0) === getSessionCharacterID(session)"), "issuer = record.issuerID");
    assert.ok(contractRuntime.includes("issuerWallet: cloneWalletRef(issuerWalletRef),"), "record.issuerWallet = cloneWalletRef");
  });

  const marketText = (...parts) => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    return fs.readFileSync(path.join(src, "services", "market", ...parts), "utf8").replace(/\r\n/g, "\n");
  };
  const bodyOf = (source, head, close = "\n}\n") => {
    const at = source.indexOf(head);
    assert.ok(at >= 0, `${head} present`);
    const rest = source.slice(at);
    const end = rest.indexOf(close);
    assert.ok(end > 0, `${head} closed by ${JSON.stringify(close)}`);
    return rest.slice(0, end);
  };

  test("FM1 vendor facts: matchBuyOrdersForSeller delivers to escrow ownerId, skips no owner / saga, needs a buy record", () => {
    const fn = bodyOf(marketText("marketProxyService.js"), "async function matchBuyOrdersForSeller(");
    assert.match(fn, /buyerCharacterID = normalizePositiveInteger\(\s*buyerEscrowRecord && buyerEscrowRecord\.ownerId,/);
    assert.match(fn, /if \(!buyerCharacterID\) \{\s*continue;/);
    assert.ok(fn.includes('getEscrowType(escrowRecord) !== "buy"'), "a non-seed bid needs a buy record");
    assert.match(fn, /if \(hasPendingMarketFillSagaForOrder\(buyOrder && buyOrder\.order_id\)\) \{\s*continue;/);
    assert.match(fn, /id: normalizePositiveInteger\(buyerEscrowRecord\.walletOwnerId, 0\),\s*accountKey: buyerEscrowRecord\.accountKey,/);
  });

  test("FM2 vendor facts: buy fill saga delivers to HANGAR of buyerCharacterID, removes the record when filled", () => {
    const fn = bodyOf(marketText("marketProxyService.js"), "async function executePlayerBuyFillSagaUnlocked(");
    assert.match(fn, /ownerID: saga\.buyerCharacterID,\s*locationID: saga\.destinationStationID,\s*flagID: ITEM_FLAGS\.HANGAR,/);
    assert.match(fn, /if \(fillResponse\.state === "filled"\) \{\s*requireDurableMarketSagaWrite\(\s*removeEscrowRecordDurable\(saga\.orderID\),/);
    assert.match(fn, /putEscrowRecordDurable\(\{\s*\.\.\.escrowRecord,[^}]*pendingFill: null,/);
    assert.ok(fn.includes("removeEscrowRecordDurable(saga.crossingOrderID)"), "a crossing saga rewrites / removes the crossing record");
  });

  test("FM3 vendor facts: applyTerminalOrderEvent refunds only with a matching record, to its accountKey", () => {
    const fn = bodyOf(marketText("marketProxyService.js"), "async function applyTerminalOrderEvent(");
    const guard = fn.indexOf("if (!escrowRecord || escrowType !==");
    const credit = fn.indexOf("await creditCharacterWallet(");
    assert.ok(guard >= 0 && credit > guard, "no record -> no refund (the guard stands before the credit)");
    assert.ok(fn.includes("accountKey: escrowRecord.accountKey"), "corp refund to the record's division");
    assert.ok(fn.includes("roundIsk(escrowRecord.escrowAmount)"), "refund = record escrowAmount");
    assert.ok(fn.includes("removeEscrowRecordDurable(orderID)"), "record removed after the refund");
  });

  test("FM4 vendor facts: saga persisted before execution without await after the record read; saga check fields", () => {
    const source = marketText("marketProxyService.js");
    const fn = bodyOf(source, "async function matchBuyOrdersForSeller(");
    const persist = fn.indexOf("persistPlayerBuyFillSaga(escrowRecord, saga);");
    assert.ok(persist >= 0 && persist < fn.indexOf("executePlayerBuyFillSaga("), "persist before execute");
    const read = fn.indexOf("getEscrowRecord(buyOrder");
    assert.ok(read >= 0 && read < persist, "record read before the saga write");
    assert.ok(!/\bawait\b/.test(fn.slice(read, persist)), "no await between getEscrowRecord(buyOrder and persistPlayerBuyFillSaga");
    assert.match(bodyOf(source, "function persistPlayerBuyFillSaga("), /putEscrowRecordDurable\(\{\s*\.\.\.escrowRecord,[^}]*pendingFill: saga,/);
    const check = bodyOf(source, "function hasPendingMarketFillSagaForOrder(");
    for (const text of ["listEscrowRecords()", "escrowRecord && escrowRecord.pendingFill", "normalizeOrderId(saga.orderID)",
      "normalizeOrderId(saga.crossingOrderID)"]) assert.ok(check.includes(text), text);
    assert.ok(!exportsName(source, "hasPendingMarketFillSagaForOrder"), "not exported: the adapter keeps a replica");
  });

  test("FM5 vendor facts: executeBuyRequest PlaceOrder params (bid, station range, station_metadata of 261108.1)", () => {
    const source = marketText("marketProxyService.js");
    const fn = bodyOf(source, "async function executeBuyRequest(");
    const call = bodyOf(fn, 'marketDaemonClient.call("PlaceOrder", {', "});");
    for (const key of ["owner_id:", "is_corp:", "station_id:", "station_metadata: buildNativeStationMetadata(stationID),",
      "type_id:", "price:", "quantity:", "min_volume:", "duration_days:", "range_value: normalizeInteger(orderRange, RANGE_STATION),",
      "bid: true,", 'source: "player",']) assert.ok(call.includes(key), key);
    assert.match(fn, /upsertBuyEscrowRecord\([\s\S]*?\{ durable: true \},/);
    const meta = bodyOf(source, "function buildNativeStationMetadata(");
    for (const text of ['const worldData = require("../../space/worldData");', "worldData.getStationByID(Number(stationID))",
      "station.isStructure) {", "return buildNativeStructureMetadata(stationID, worldData);",
      "station_id: Number(station.stationID), solar_system_id: Number(station.solarSystemID),",
      "constellation_id: Number(station.constellationID), region_id: Number(station.regionID),",
      'station_name: String(station.stationName || ""), security: Number(station.security || 0),']) assert.ok(meta.includes(text), text);
  });

  test("FM6 vendor facts: missing order text and unavailable phrases of marketProxyService", () => {
    const source = marketText("marketProxyService.js");
    assert.ok(bodyOf(source, "function isMarketDaemonMissingOrderError(").includes("`order ${normalizeOrderId(orderID)} not found`"));
    const unavailable = bodyOf(source, "function isMarketDaemonUnavailableError(");
    assert.ok(unavailable.includes("error.marketDaemonOutcomeUnknown === true"), "outcome unknown = unavailable");
    for (const phrase of ["market daemon rpc connect timeout", "market daemon rpc socket closed before connect",
      "market daemon rpc connection is not ready", "market daemon rpc connection closed", "market daemon rpc request timed out",
      "econnrefused", "econnreset", "enetunreach", "ehostunreach"]) assert.ok(unavailable.includes(`"${phrase}"`), phrase);
  });

  test("FM7 vendor facts: marketEscrowState exports the 4 symbols, durable writes flush, _meta not listed", () => {
    const source = marketText("marketEscrowState.js");
    for (const name of ["getEscrowRecord", "putEscrowRecordDurable", "removeEscrowRecordDurable", "listEscrowRecords"]) {
      assert.ok(exportsName(source, name), name);
    }
    assert.ok(bodyOf(source, "function putEscrowRecordDurable(").includes("flushEscrowTableSync()"), "put flushes");
    assert.ok(bodyOf(source, "function removeEscrowRecordDurable(").includes("flushEscrowTableSync()"), "remove flushes");
    assert.ok(bodyOf(source, "function listEscrowRecords(").includes("key !== META_KEY"), "the saga counter row is not a record");
    assert.ok(bodyOf(source, "function getEscrowRecord(").includes("cloneValue(result.data)"), "reads are clones");
  });

  test("FM8 vendor facts: marketRules ALLOWED_DURATIONS + isAllowedDuration export; RANGE_STATION = -1", () => {
    const rules = marketText("marketRules.js");
    assert.ok(rules.includes("const ALLOWED_DURATIONS = new Set([0, 1, 3, 7, 14, 30, 90]);"));
    assert.ok(bodyOf(rules, "function isAllowedDuration(").includes("ALLOWED_DURATIONS.has("));
    assert.ok(exportsName(rules, "isAllowedDuration"), "isAllowedDuration exported");
    assert.ok(marketText("marketTopology.js").includes("const RANGE_STATION = -1;"));
  });

  test("FM9 vendor facts: Handle_GetCorporationOrders asks GetCorporationOrders is_corp:true, no escrow sync", () => {
    const fn = bodyOf(marketText("marketProxyService.js"), "async Handle_GetCorporationOrders(", "\n  }\n");
    assert.match(fn, /marketDaemonClient\.call\("GetCorporationOrders", \{\s*owner_id: corporationID,\s*is_corp: true,\s*\}\)/);
    assert.ok(!fn.includes("syncOpenBuyEscrowRecords"), "no escrow sync on the corp list");
    assert.ok(fn.includes('String(order && order.state ? order.state : "open").toLowerCase() === "open"'), "state absent = open");
  });

  const vendorText = (rel) => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    return fs.readFileSync(path.join(src, "services", ...rel.split("/")), "utf8").replace(/\r\n/g, "\n");
  };

  test("FM10 vendor facts: a corp escrow refund fails for good only with CORPORATION_NOT_FOUND (event cursor stake)", () => {
    const market = marketText("marketProxyService.js");
    const poll = bodyOf(market, "async function processPendingExpiryEvents(");
    const apply = poll.indexOf("await applyTerminalOrderEvent(event);");
    assert.ok(apply >= 0 && apply < poll.indexOf("setLastProcessedOrderEventId("), "apply before the cursor write");
    const credit = bodyOf(market, "async function creditCharacterWallet(");
    assert.match(credit, /if \(!\(normalizedAmount > 0\)\) \{\s*return null;/);
    const corpAt = credit.indexOf("if (options.isCorp) {");
    assert.ok(corpAt >= 0, "isCorp branch");
    const corp = credit.slice(corpAt, credit.indexOf("return result;", corpAt));
    assert.ok(corp.includes("await adjustCorporationWalletDivisionBalanceAsync("), "corp credit seam");
    assert.ok(corp.includes("idempotencyKey: options.idempotencyKey,") && !corp.includes("requireExactCredit"),
      "the caller's key, no exact credit");
    const terminal = bodyOf(market, "async function applyTerminalOrderEvent(");
    assert.ok(terminal.includes("idempotencyKey: `market:terminal:${eventType}:${orderID}:buy-refund`,"),
      "the refund key is fixed per order and event");
    assert.strictEqual(corp.split("throwWrappedUserError(").length - 1, 1, "one throw");
    assert.match(corp, /if \(!result\.success\) \{\s*throwWrappedUserError\(/);
    const wallet = vendorText("corporation/corpWalletState.js");
    const adjust = bodyOf(wallet, "function applyAdjustCorporationWalletDivisionBalance(");
    const keyAt = adjust.indexOf("if (key !== null");
    const balanceAt = adjust.indexOf("const currentBalance = getCorporationWalletBalance(");
    assert.ok(keyAt >= 0 && balanceAt > keyAt, "key block before the balance read");
    for (const code of ["IDEMPOTENCY_KEY_INVALID", "IDEMPOTENCY_KEY_REUSED", "WALLET_ADJUSTMENT_WRITE_AMBIGUOUS"]) {
      const at = adjust.indexOf(`"${code}"`);
      assert.ok(at > keyAt && at < balanceAt, `${code} inside if (key !== null)`);
    }
    assert.strictEqual(adjust.indexOf("WALLET_RECEIPT_LIMIT"), -1, "no receipt limit refusal");
    assert.strictEqual(adjust.slice(0, keyAt).indexOf("success: false"), -1, "no refusal before the key block");
    const tail = adjust.slice(balanceAt);
    assert.match(tail, /if \(options\.requireExactCredit === true && nextBalance > MAX_WALLET_BALANCE\) \{\s*return \{ success: false, errorMsg: "WALLET_LIMIT" \};/);
    assert.match(tail, /if \(nextBalance < -0\.0001\) \{\s*return \{\s*success: false,\s*errorMsg: "INSUFFICIENT_FUNDS",/);
    assert.strictEqual(tail.split("success: false").length - 1, 2, "only WALLET_LIMIT and INSUFFICIENT_FUNDS after the key block");
    const set = bodyOf(wallet, "function applySetCorporationWalletDivisionBalance(");
    assert.match(set, /Math\.min\(\s*normalizeMoney\(nextBalance, previousBalance\),\s*MAX_WALLET_BALANCE,\s*\)/);
    assert.ok(set.includes('errorMsg: "CORPORATION_NOT_FOUND"'), "CORPORATION_NOT_FOUND");
    const runtime = vendorText("corporation/corporationRuntimeState.js");
    const update = bodyOf(runtime, "function updateCorporationRuntime(");
    assert.match(update, /const corporationRecord = getCorporationRecord\(corporationID\);\s*if \(!corporationRecord\) \{/);
    assert.match(runtime, /getCorporationRecord,[\s\S]{0,200}?\} = require\(path\.join\(__dirname, "\.\/corporationState"\)\);/);
    assert.ok(wallet.includes("const CORPORATION_WALLET_KEY_END = 1006;"));
  });

  test("F2 vendor facts obs-02: beyonceService measures ly from solarSystems position", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const beyonce = fs.readFileSync(path.join(src, "services", "ship", "beyonceService.js"), "utf8");
    assert.ok(beyonce.includes("sourceSystem.position"), "sourceSystem.position");
    assert.ok(/^const LIGHT_YEAR_METERS = 9460730472580800;/m.test(beyonce), "LIGHT_YEAR_METERS in metres");
  });

  test("F-DOCK vendor facts: Handle_CmdDock on the exported class, dynamic handler lookup "
    + "approach only from CmdDock, refusal and capsule exports", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const read = (...p) => fs.readFileSync(path.join(src, ...p), "utf8").replace(/\r\n/g, "\n");
    const beyonce = read("services", "ship", "beyonceService.js");
    assert.ok(/^module\.exports = BeyonceService;$/m.test(beyonce), "module.exports = BeyonceService;");
    assert.ok(/^class BeyonceService extends BaseService \{$/m.test(beyonce), "class BeyonceService");
    assert.ok(beyonce.includes("\n  Handle_CmdDock(args, session) {\n"), "Handle_CmdDock(args, session) {");
    assert.ok(beyonce.includes("throwWrappedUserError(\"DockingRequestDenied\", {"), "vendor DockingRequestDenied");
    const base = read("services", "baseService.js");
    assert.ok(base.includes("const handlerName = `Handle_${normalizedMethod}`;"), "handler name per call");
    assert.ok(base.includes("this[handlerName](args, session, kwargs, callContext)"), "dynamic this[handlerName]");
    const callers = { startDockingApproach: new Set(), startStationDockingApproach: new Set() };
    const files = ["space", "services", "_secondary"].flatMap((d) => listJs(path.join(src, d)));
    for (const file of files) {
      const text = readSrcCached(file);
      if (!text.includes("DockingApproach(")) continue;
      for (const line of text.split(/\r?\n/)) {
        const code = line.replace(/\/\/.*$/, "");
        for (const name of Object.keys(callers)) {
          if (!code.includes(`${name}(`)) continue;
          if (new RegExp(`^\\s*(async\\s+)?${name}\\s*\\(`).test(code) || code.includes(`function ${name}(`)) continue;
          callers[name].add(path.relative(src, file).split(path.sep).join("/"));
        }
      }
    }
    assert.deepStrictEqual([...callers.startDockingApproach], ["services/ship/beyonceService.js"]);
    assert.deepStrictEqual([...callers.startStationDockingApproach], ["space/runtime/spaceRuntime/docking.js"]);
    const macho = read("common", "machoErrors.js");
    assert.ok(exportsName(macho, "throwWrappedUserError"), "machoErrors exports throwWrappedUserError");
    const items = read("services", "inventory", "itemStore.js");
    for (const name of ["findItemById", "isCapsuleTypeID"]) assert.ok(exportsName(items, name), `itemStore ${name}`);
    assert.ok(/function findItemById\(itemId\) \{[\s\S]{0,300}?cloneValue\(entry\)/.test(items), "findItemById clones");
  });

  test("TA5 vendor facts: sovState exports getSystemState with tableCache.systems, getSystemSovClaim, buildCampaignOutcomeReceiptKey, normalizeCampaignOutcomeReceipt toLowerCase, attacker branch zeros allianceID/claimStructureID next to campaignOutcomeReceipts, sov-campaign: format, filetimeToUnixMs + FILETIME constants, sovStore exports readSovereigntyTableUpdatedAt", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const sovState = fs.readFileSync(path.join(src, "services", "sovereignty", "sovState.js"), "utf8");
    const sovStore = fs.readFileSync(path.join(src, "services", "sovereignty", "sovStore.js"), "utf8");

    assert.ok(/function getSystemState\(solarSystemID\) \{\s+ensureLoaded\(\);\s+const numericSolarSystemID = normalizePositiveInteger\(solarSystemID, null\);\s+if \(!numericSolarSystemID\) \{\s+return null;\s+\}\s+return tableCache\.systems\[String\(numericSolarSystemID\)\] \|\| null;/m.test(sovState),
      "getSystemState returns tableCache.systems[]");

    assert.ok(/function buildCampaignOutcomeReceiptKey\(targetID, campaignEpoch\) \{\s+return `\$\{normalizePositiveInteger\(targetID, 0\)\}:\$\{String\(campaignEpoch \|\| ""\)\.trim\(\)\}`;/.test(sovState),
      "buildCampaignOutcomeReceiptKey = targetID:campaignEpoch");

    assert.ok(/const result = String\(value\.result \|\| ""\)\.trim\(\)\.toLowerCase\(\);/.test(sovState),
      "normalizeCampaignOutcomeReceipt toLowerCase on result");

    assert.ok(sovState.includes("result === \"attacker\"") && sovState.includes("allianceID") && sovState.includes("claimStructureID") && sovState.includes("campaignOutcomeReceipts"),
      "attacker branch zeros allianceID/claimStructureID near campaignOutcomeReceipts");

    const sovCampaignState = fs.readFileSync(path.join(src, "services", "sovereignty", "sovCampaignState.js"), "utf8");
    assert.ok(sovCampaignState.includes("campaignEpoch: `sov-campaign:${target.solarSystemID}:${target.targetID}:"),
      "sov-campaign: format present");

    assert.ok(/const FILETIME_EPOCH_OFFSET = 116444736000000000n;/.test(sovState) || sovState.includes("FILETIME_EPOCH_OFFSET"),
      "FILETIME_EPOCH_OFFSET constant");
    assert.ok(/const FILETIME_TICKS_PER_MILLISECOND = 10000n;/.test(sovState) || sovState.includes("FILETIME_TICKS_PER_MILLISECOND"),
      "FILETIME_TICKS_PER_MILLISECOND constant");
    assert.ok(/function filetimeToUnixMs\(value, fallback = 0\) \{\s+const filetime = normalizeFiletimeBigInt\(value, 0n\);/.test(sovState),
      "filetimeToUnixMs function");

    assert.ok(/function readSovereigntyTableUpdatedAt\(\) \{\s+const result = database\.read\(SOVEREIGNTY_TABLE, "\/_meta"\);/.test(sovStore),
      "readSovereigntyTableUpdatedAt exported");
  });

  test("T5b mod facts: requires stay in the mod (server via adapter), no timers, no BOM, silent config", () => {
    const files = [path.join(MOD_DIR, "loader.js"), path.join(MOD_DIR, "config.js"), ...listJs(path.join(MOD_DIR, "lib"))];
    assert.ok(!fs.readFileSync(path.join(MOD_DIR, "config.js"), "utf8").includes("console."), "config.js prints");
    const bom = String.fromCharCode(0xfeff);
    const violations = [];
    const dynamic = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const rel = path.relative(MOD_DIR, file);
      const inAdapter = file.startsWith(ADAPTER_DIR + path.sep);
      for (const match of source.matchAll(/\brequire\s*\(([^)]*)\)/g)) {
        const literal = /^\s*"([^"]+)"\s*$/.exec(match[1]);
        const target = literal ? literal[1] : null;
        if (!target) {
          if (inAdapter) dynamic.push(rel);
          else violations.push(`${rel}: require(${match[1]})`);
        } else if (target.startsWith("node:")) {
          continue;
        } else if (!(target.startsWith("./") || target.startsWith("../"))) {
          violations.push(`${rel}: require(${match[1]})`);
        } else if (!inAdapter && !path.resolve(path.dirname(file), target).startsWith(MOD_DIR + path.sep)) {
          violations.push(`${rel}: require(${match[1]}) leaves the mod`);
        } else if (inAdapter && !path.resolve(path.dirname(file), target).startsWith(ADAPTER_DIR + path.sep)) {
          violations.push(`${rel}: require(${match[1]}) - the adapter requires a domain module`);
        }
      }
      if (rel !== path.join("lib", "log.js") && source.includes("console.")) violations.push(`${rel}: console.`);
      if (rel === path.join("lib", "telemetry", "index.js")) {
        const intervals = (source.match(/\bsetInterval\s*\(/g) || []).length;
        if (intervals !== 1 || !source.includes(".unref()") || /\bsetTimeout\s*\(/.test(source)) {
          violations.push(`${rel}: expected exactly one unref'd setInterval, got ${intervals}`);
        }
      } else if (rel === path.join("lib", "world", "invasions", "incursionUi.js")) {
        const intervals = (source.match(/\bsetInterval\s*\(/g) || []).length;
        if (intervals !== 1 || !source.includes(".unref()") || /\bsetTimeout\s*\(/.test(source)) {
          violations.push(`${rel}: expected exactly one unref'd setInterval, got ${intervals}`);
        }
      } else if (rel === path.join("lib", "world", "controlSeed.js")) {
        const timeouts = (source.match(/\bsetTimeout\s*\(/g) || []).length;
        if (timeouts !== 1 || !source.includes(".unref()") || /\bsetInterval\s*\(/.test(source)) {
          violations.push(`${rel}: expected exactly one unref'd setTimeout, got ${timeouts}`);
        }
      } else if (rel === path.join("lib", "scheduler", "driver.js")
        || rel === path.join("lib", "presence", "poller.js")
        || rel === path.join("lib", "persistence", "checkpointer.js")) {
        const timeouts = (source.match(/\bsetTimeout\s*\(/g) || []).length;
        if (timeouts !== 1 || !source.includes(".unref()") || /\bsetInterval\s*\(/.test(source)) {
          violations.push(`${rel}: expected exactly one unref'd setTimeout, got ${timeouts}`);
        }
      } else if (/\bset(Timeout|Interval)\s*\(/.test(source)) {
        violations.push(`${rel}: timer`);
      }
      if (source.includes(bom)) violations.push(`${rel}: literal U+FEFF (use the \\uFEFF escape)`);
    }
    const webDir = path.join(MOD_DIR, "web");
    for (const name of ["index.html", "app.js", "app.css", "galaxy.js", "killboard.html", "killboard.js",
      "killboard.css"]) {
      const source = fs.readFileSync(path.join(webDir, name), "utf8");
      if (source.includes(bom)) violations.push(`web/${name}: literal U+FEFF`);
      if (/https?:\/\/(?!127\.0\.0\.1)/.test(source)) violations.push(`web/${name}: external URL (no CDN)`);
    }
    for (const name of ["app.js", "galaxy.js", "killboard.js"]) {
      const page = fs.readFileSync(path.join(webDir, name), "utf8");
      for (const banned of [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /document\.write/,
        /\beval\s*\(/, /\bnew\s+Function\b/, /setAttribute\(\s*"style"/, /\bsetInterval\s*\(/]) {
        if (banned.test(page)) violations.push(`web/${name}: ${banned}`);
      }
    }
    const kbHtml = fs.readFileSync(path.join(webDir, "killboard.html"), "utf8");
    for (const banned of [/\sstyle\s*=/, /<script(?![^>]*\bsrc=)/, /\son[a-z]+\s*=/]) {
      if (banned.test(kbHtml)) violations.push(`web/killboard.html: ${banned}`);
    }
    assert.ok(files.length >= 4, `expected loader + lib files, got ${files.length}`);
    assert.deepStrictEqual(violations, []);
    assert.deepStrictEqual(dynamic, [path.join("lib", "adapter", "index.js")], "one dynamic require, in the adapter");
    const createRequireFiles = files.filter((file) => /\bcreateRequire\b/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(MOD_DIR, file));
    assert.deepStrictEqual(createRequireFiles, [path.join("lib", "adapter", "sqliteDriver.js")],
      "createRequire only in lib/adapter/sqliteDriver.js");
  });

  const entrypoint = path.resolve(MOD_DIR, "..", "..", "docker", "entrypoint.sh");
  const s5 = "S5 entrypoint facts: livingNewEden loader twice, last --require, 7 other mods twice, LF only";
  if (!fs.existsSync(entrypoint)) skip(s5, `${entrypoint} not found`);
  else {
    test(s5, () => {
      const source = fs.readFileSync(entrypoint, "utf8");
      assert.ok(!source.includes("\r"), "entrypoint.sh must keep LF line endings");
      const lines = source.split("\n");
      const ours = "/app/mods/livingNewEden/loader.js";
      const at = lines.map((l, i) => (l.includes(ours) ? i : -1)).filter((i) => i >= 0);
      assert.strictEqual(at.length, 2, "two blocks: run_server, run_all");
      for (const i of at) {
        assert.ok(/^\s*--require \/app\/mods\/livingNewEden\/loader\.js \\$/.test(lines[i]), lines[i]);
        assert.ok(!lines[i + 1].includes("--require"), `line after ${i + 1}: ${lines[i + 1]}`);
      }
      const others = ["soloProgressionBalance", "autopilotJumpZero", "moonOreAnomalies", "droneClassBalance",
        "EveJS-AdvancedUtilityDrones-1.0.3", "npcKillsGiveSp", "blueprintDrops"];
      for (const mod of others) {
        assert.strictEqual(source.split(`--require /app/mods/${mod}/loader.js`).length - 1, 2, mod);
      }
    });
  }
};
