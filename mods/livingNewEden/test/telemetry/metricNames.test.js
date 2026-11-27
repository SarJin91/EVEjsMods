"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { CHANNELS, isMetricName, createRegistry } = require("../../lib/telemetry/registry");
const { MODULE_CHANNELS, REGISTRY_ALARM_COUNTERS, TX_OUTCOMES, CHECKPOINT_COUNTS,
  buildSnapshot } = require("../../lib/telemetry/snapshot");
const { SCHEMA } = require("../../config");
const { REASON_METRIC_SUFFIXES } = require("../../lib/adapter/sovProjection");
const { COUNTER_NAMES: RETENTION_COUNTER_NAMES } = require("../../lib/retention/schema");
const { COUNTER_NAMES: LOCAL_PILOTS_COUNTER_NAMES } = require("../../lib/localPilots/schema");
const { COUNTER_NAMES: LOCAL_CONTACTS_COUNTER_NAMES } = require("../../lib/localPilots/contacts/schema");
const { COUNTER_NAMES: CREWS_COUNTER_NAMES } = require("../../lib/crews/schema");
const { COUNTER_NAMES: MINING_ENCOUNTERS_COUNTER_NAMES } = require("../../lib/miningEncounters/schema");
const { COUNTER_NAMES: HEAVY_EVENTS_COUNTER_NAMES } = require("../../lib/heavyEvents/schema");
const { COUNTER_NAMES: AMBIENT_RATS_COUNTER_NAMES } = require("../../lib/ambientRats/schema");
const { COUNTER_NAMES: OFFICER_SPAWNS_COUNTER_NAMES } = require("../../lib/officers/schema");
const { NEMESIS_COUNTER_NAMES } = require("../../lib/nemesis/schema");
const { COUNTER_NAMES: FREE_CORPS_COUNTER_NAMES,
  VENTURE_KIND_COUNTER_NAMES: FREE_CORPS_VENTURE_KIND_COUNTER_NAMES } = require("../../lib/freeCorps/schema");
const { COUNTER_NAMES: LISTENING_POST_COUNTER_NAMES } = require("../../lib/listeningPosts/schema");
const { COUNTER_NAMES: SITUATIONS_COUNTER_NAMES } = require("../../lib/situations/schema");
const { COUNTER_NAMES: GAME_MASTER_COUNTER_NAMES } = require("../../lib/gameMaster/schema");
const { COUNTER_NAMES: ARCHAEOLOGY_COUNTER_NAMES } = require("../../lib/archaeology/schema");
const { COUNTER_NAMES: POPULATION_COUNTER_NAMES } = require("../../lib/population/schema");
const { FAME_COUNTER_NAMES } = require("../../lib/fame/schema");
const { COUNTER_NAMES: MAP_WINDOW_COUNTER_NAMES } = require("../../lib/inGameMap/window/schema");

const LIB_DIR = path.resolve(__dirname, "..", "..", "lib");
const NOW_MS = 1700000000000;
const STRING_RE = /"([^"]+)"/g;
const BATTLE_BUMP_RE = /\b(?:bump|gauge|observe)\(\s*"([A-Za-z0-9_.]+)"/g;
const CALL_RE = /\b(?:count|gauge|observe|metric|onCount)\(\s*(?:"(?:count|gauge|observe)",\s*)?(["'`])([^"'`]*)\1/g;
const CONST_RE = /\bconst METRIC_[A-Z0-9_]+\s*=\s*(["'`])([^"'`]*)\1/g;
const PAIR_RE = /\[\s*"([a-zA-Z][a-zA-Z0-9]*\.[A-Za-z0-9_.]+)",\s*"[A-Za-z0-9_]+"\s*\]/g;
const PLACEHOLDER_RE = /\$\{[^}]*\}/g;

function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function metricNamesOf(source) {
  const out = [];
  for (const [re, group] of [[CALL_RE, 2], [CONST_RE, 2], [PAIR_RE, 1]]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const literal = m[group];
      if (!literal.includes(".")) continue;
      out.push({ literal, name: literal.replace(PLACEHOLDER_RE, "x") });
    }
  }
  return out;
}

function defaultOf(key) {
  return SCHEMA.find((row) => row.key === key).default;
}

function stringsOf(text) {
  return [...text.matchAll(STRING_RE)].map((m) => m[1]);
}

function frozenArray(source, name) {
  const m = new RegExp(`const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`).exec(source);
  return m ? stringsOf(m[1]) : null;
}

function loopArray(source, index, literal) {
  const v = /\$\{(\w+)\}/.exec(literal);
  if (!v) return null;
  const re = new RegExp(`for \\(const ${v[1]} of \\[([^\\]]*)\\]\\)`, "g");
  let found = null;
  let m;
  while ((m = re.exec(source)) !== null && m.index < index) found = stringsOf(m[1]);
  return found;
}

function battleShortNames() {
  const out = [];
  for (const file of listJs(path.join(LIB_DIR, "battle"))) {
    if (path.basename(file) === "settlement.js") continue;
    for (const m of fs.readFileSync(file, "utf8").matchAll(BATTLE_BUMP_RE)) out.push(m[1]);
  }
  const outcomes = frozenArray(fs.readFileSync(path.join(LIB_DIR, "battle", "schema.js"), "utf8"), "OUTCOMES");
  return out.concat(outcomes.map((o) => `outcome.${o}`));
}

const TEMPLATE_SETS = Object.freeze({
  "battle/index.js|battle.${name}": battleShortNames,
  "persistence/checkpointer.js|persistence.checkpoints.${reason}": () => CHECKPOINT_COUNTS,
  "telemetry/index.js|persistence.tx.${outcome}": () => TX_OUTCOMES,
  "world/wreckConsequence.js|world.wrecks.${name}": (source) => [...source.matchAll(/\bbump\("(\w+)"\)/g)]
    .map((m) => m[1]),
  "adapter/index.js|sovProjection.${action.toLowerCase()}": () => ["gain", "loss", "transfer", "reinforce"],
  "world/sovProjection/listener.js|sovProjection.${reason}": () => REASON_METRIC_SUFFIXES,
  "world/sovProjection/sync.js|sovProjection.${reason}": () => REASON_METRIC_SUFFIXES,
  "retention/retentionService.js|persistence.retention.${name}": () => RETENTION_COUNTER_NAMES,
  "localPilots/index.js|localPilots.${name}": () => LOCAL_PILOTS_COUNTER_NAMES,
  "localPilots/contacts/service.js|localContacts.${name}": () => LOCAL_CONTACTS_COUNTER_NAMES,
  "crews/index.js|crews.${name}": () => CREWS_COUNTER_NAMES,
  "miningEncounters/index.js|world.miningEncounters.${name}": () => MINING_ENCOUNTERS_COUNTER_NAMES,
  "ambientRats/index.js|world.ambientRats.${name}": () => AMBIENT_RATS_COUNTER_NAMES,
  "officers/service.js|events.officerSpawns.${name}": () => OFFICER_SPAWNS_COUNTER_NAMES,
  "nemesis/step.js|bounty.${name}": () => NEMESIS_COUNTER_NAMES,
  "heavyEvents/index.js|world.heavyEvents.${name}": () => HEAVY_EVENTS_COUNTER_NAMES,
  "freeCorps/index.js|freeCorps.${name}": () => FREE_CORPS_COUNTER_NAMES,
  "freeCorps/index.js|freeCorps.ventures.${kind}.${event}": () => FREE_CORPS_VENTURE_KIND_COUNTER_NAMES,
  "listeningPosts/service.js|listeningPost.${name}": () => LISTENING_POST_COUNTER_NAMES,
  "situations/service.js|situations.${name}": () => SITUATIONS_COUNTER_NAMES,
  "gameMaster/service.js|gameMaster.${name}": () => GAME_MASTER_COUNTER_NAMES,
  "archaeology/service.js|archaeology.${name}": () => ARCHAEOLOGY_COUNTER_NAMES,
  "population/service.js|population.${name}": () => POPULATION_COUNTER_NAMES,
  "fame/service.js|fame.${name}": () => FAME_COUNTER_NAMES,
  "inGameMap/window/service.js|inGameMap.window.${name}": () => MAP_WINDOW_COUNTER_NAMES,
});

function closedMetricNames() {
  const names = new Set(REGISTRY_ALARM_COUNTERS);
  const unknown = [];
  for (const file of listJs(LIB_DIR)) {
    const rel = path.relative(LIB_DIR, file).split(path.sep).join("/");
    const source = fs.readFileSync(file, "utf8");
    for (const [re, group] of [[CALL_RE, 2], [CONST_RE, 2], [PAIR_RE, 1]]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(source)) !== null) {
        const literal = m[group];
        if (!literal.includes(".")) continue;
        if (!literal.includes("${")) {
          names.add(literal);
          continue;
        }
        const special = TEMPLATE_SETS[`${rel}|${literal}`];
        const set = special ? special(source)
          : (literal.endsWith(".${name}") && frozenArray(source, "COUNTER_NAMES")) || loopArray(source, m.index, literal);
        if (!set || set.length === 0) {
          unknown.push(`${rel}: ${literal}`);
          continue;
        }
        const prefix = literal.slice(0, literal.indexOf("${"));
        for (const suffix of set) names.add(`${prefix}${suffix}`);
      }
    }
  }
  assert.deepStrictEqual(unknown, [], `templates without a closed set (add to TEMPLATE_SETS):\n${unknown.join("\n")}`);
  return names;
}

function snapshotState(registry, histogramSamples) {
  return { seq: 1, capturedAtMs: NOW_MS, startedAtMs: NOW_MS, intervalMs: 10000, histogramSamples,
    status: { tick: "ok" }, process: { pid: 1 }, metrics: registry.read(),
    tick: { sceneCount: 0, tickedSceneCount: 0, samplesTotal: 0, lastSampleAgeMs: null, wrapErrors: 0 },
    gcKinds: {}, capture: { lastWriteMs: 0, writeSkips: 0, writeErrors: 0, lastWriteError: "", path: null } };
}

module.exports = ({ test }) => {
  test("MN1 every metric name used in lib/ passes isMetricName (a prefix without a channel fails)", () => {
    const found = [];
    for (const file of listJs(LIB_DIR)) {
      const rel = path.relative(LIB_DIR, file).split(path.sep).join("/");
      for (const n of metricNamesOf(fs.readFileSync(file, "utf8"))) found.push({ file: rel, ...n });
    }
    const literals = new Set(found.map((f) => f.literal));
    for (const expected of ["logistics.${name}", "logistics.stepMs", "mining.${name}", "mining.stepMs",
      "production.${name}", "production.stepMs", "salvage.${name}", "salvage.activeJobs", "stations.seed.${name}",
      "stations.repairSearchMs", "scheduler.passMs", "graph.systems", "observer.galaxyFleetsMs"]) {
      assert.ok(literals.has(expected), `scan must find ${expected}`);
    }
    const bad = found.filter((f) => !isMetricName(f.name)).map((f) => `${f.file}: ${f.literal}`);
    assert.deepStrictEqual(bad, [], `metric names refused by the registry (add the channel to CHANNELS):\n${bad.join("\n")}`);

    const probe = metricNamesOf("metric(\"count\", `foo.${name}`, n); telemetry.observe(\"bar.stepMs\", 1);");
    assert.deepStrictEqual(probe.map((p) => [p.name, isMetricName(p.name)]), [["foo.x", false], ["bar.stepMs", false]]);
  });

  test("MN2 every snapshot module channel is a registry channel", () => {
    assert.deepStrictEqual(MODULE_CHANNELS.filter((c) => !CHANNELS.includes(c)), []);
    for (const c of ["logistics", "mining", "production", "salvage", "stations", "graph", "world"]) {
      assert.ok(MODULE_CHANNELS.includes(c), `snapshot groups ${c}`);
    }
    const FIXED = ["tick", "gc", "process", "persistence", "journal", "capture", "telemetry"];
    assert.deepStrictEqual(CHANNELS.filter((c) => !FIXED.includes(c) && !MODULE_CHANNELS.includes(c)), []);
    const snap = buildSnapshot(snapshotState(createRegistry({ histogramSamples: 8, maxMetrics: 8 }), 8));
    assert.deepStrictEqual([snap.channels.graph, snap.channels.world], [{}, {}]);
  });

  test("MN3 closed metric name sets of lib/ fit the default maxMetrics; alarm counters registered at start", () => {
    const maxMetrics = defaultOf("telemetry.maxMetrics");
    const names = closedMetricNames();
    assert.ok(names.size > 256, `scan sees the known sets (got ${names.size})`);
    assert.ok(names.size <= maxMetrics, `${names.size} closed metric names > default telemetry.maxMetrics ${maxMetrics}`);

    const registry = createRegistry({ histogramSamples: 8, maxMetrics: REGISTRY_ALARM_COUNTERS.length + 1 });
    for (const name of REGISTRY_ALARM_COUNTERS) assert.strictEqual(registry.count(name, 0), true, name);
    assert.strictEqual(registry.count("battle.filler", 1), true);
    assert.strictEqual(registry.count("battle.overflow", 1), false, "registry full");
    assert.deepStrictEqual(buildSnapshot(snapshotState(registry, 8)).alarms.map((a) => [a.id, a.level, a.count]),
      [["telemetry.rejectedMetrics", "warn", 1]], "zero counters raise no alarm; overflow raises one");
    assert.strictEqual(registry.count("journal.conflicts", 1), true, "alarm counter keeps its slot when full");
    assert.deepStrictEqual(buildSnapshot(snapshotState(registry, 8)).alarms.map((a) => a.id),
      ["journal.conflict", "telemetry.rejectedMetrics"]);

    const samples = defaultOf("telemetry.histogramSamples");
    const full = createRegistry({ histogramSamples: samples, maxMetrics });
    for (let i = 0; i < maxMetrics; i += 1) {
      full.observe(`stations.${"x".repeat(50)}${String(i).padStart(4, "0")}`, 123456789.123, NOW_MS + i);
    }
    const bytes = Buffer.byteLength(JSON.stringify({ available: true, snapshot: buildSnapshot(snapshotState(full,
      samples)) }));
    const ceiling = defaultOf("observer.maxResponseBytes");
    assert.ok(bytes < ceiling, `worst case snapshot ${bytes} B >= observer.maxResponseBytes ${ceiling}`);
  });
};
