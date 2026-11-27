"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { SPEAKERS } = require("../../lib/npcVoices/data/voices");
const { ALPHABETS } = require("../../lib/npcVoices/data/glyphs");
const { startNpcVoices } = require("../../lib/npcVoices");
const { createRegistry } = require("../../lib/telemetry/registry");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1700000000000;
const SYS = 30000142;
const PLAYER = 90000001;
const GURISTAS = 500010;
const DRIFTERS = 500024;
const TICK = 250;

const SITE_ENV = Object.freeze({ EVEJS_LNE_NPC_VOICES_ENABLED: "1", EVEJS_LNE_NPC_VOICES_SITE_ENABLED: "1",
  EVEJS_LNE_NPC_VOICES_SITE_TICK_MS: String(TICK), EVEJS_LNE_NPC_VOICES_SITE_MIN_LINES: "4",
  EVEJS_LNE_NPC_VOICES_SITE_MAX_LINES: "4" });

let config = null;
function siteConfig() {
  if (!config) {
    const r = resolveConfig({ env: SITE_ENV, settings: {}, envFile: {}, modDir: MOD_DIR });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    config = r.config;
  }
  return config;
}

function fakeTimers() {
  const list = [];
  return {
    setTimer(fn, ms) {
      const t = { fn, ms, live: true };
      list.push(t);
      return { cancel: () => { t.live = false; }, hasRef: () => false };
    },
    live: () => list.filter((t) => t.live),
    fire() {
      const t = list.filter((x) => x.live).pop();
      assert.ok(t, "no armed timer");
      t.live = false;
      t.fn();
    },
  };
}

const AI_LINES = { "fv.GURISTAS.SITE_ARRIVAL": [{ id: "ai-arr-1", text: "Welcome to {system}, {pilot}. Lock up." }],
  "fv.GURISTAS.SITE_BANTER": [{ id: "ai-ban-1", text: "Keep your eyes on the hauler." },
    { id: "ai-ban-2", text: "Boss wants that one alive." }] };

function rig() {
  const clock = { t: T0 };
  const timers = fakeTimers();
  const registry = createRegistry({ histogramSamples: 16, maxMetrics: 64 });
  const sends = [];
  const demands = [];
  const adapter = { hook: null, refuse: null, uninstalled: 0,
    installSiteEntryHook(fn) {
      adapter.hook = fn;
      return { ok: true };
    },
    uninstallSiteEntryHook() {
      adapter.uninstalled += 1;
      return { ok: true };
    },
    sendCharacterSystemLine(spec) {
      sends.push({ ...spec, at: clock.t });
      return adapter.refuse ? { ok: false, reason: adapter.refuse } : { ok: true };
    },
    installChatCommand: () => ({ ok: true }),
    uninstallChatCommand: () => ({ ok: true }) };
  const chatterAi = { demand: (k) => demands.push(k),
    overlay: () => ({ ok: true, permille: 1000, linesOf: (k) => AI_LINES[k] || [] }) };
  const graph = { getGraph: () => ({ ok: true, graph: { getSystem: (id) => (id === SYS ? { name: "Jita" } : null) } }) };
  const r = startNpcVoices({ config: siteConfig(), clock: { now: () => clock.t }, worldSeed: 42, telemetry: registry,
    adapter, getChatterAi: () => chatterAi, getPresence: () => null, getGraph: () => graph, logger: { log() {} },
    setTimer: timers.setTimer });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const run = (ms) => {
    for (let left = ms; left > 0; left -= TICK) {
      clock.t += TICK;
      timers.fire();
    }
  };
  const enter = (over = {}) => adapter.hook({ characterId: PLAYER, systemId: SYS, instanceId: 7001, roomKey: "room:entry",
    siteKind: "anomaly", siteFamily: "combat", factionId: GURISTAS, pilotName: "Bob&", atMs: clock.t, ...over });
  return { v: r.npcVoices, clock, timers, registry, sends, demands, adapter, run, enter };
}

function split(line) {
  const m = /^<color=0x[0-9a-f]{8}>([^<]+)<\/color>: (.*)$/.exec(line);
  assert.ok(m, line);
  return [m[1], m[2]];
}

module.exports = ({ test }) => {
  test("FV3-3 site exchange on a fake clock: times, speakers A/B/A/B, SITE_ARRIVAL first (AI, {pilot}, {system}), "
    + "dedup of a double vendor call, cooldowns, filters, metrics", () => {
    const r = rig();
    assert.deepStrictEqual(r.v.getStatus().site.state, "running");
    const entryAt = r.clock.t;
    r.enter();
    r.enter({ atMs: r.clock.t });
    assert.strictEqual(r.sends.length, 0, "no work inside the vendor call");
    r.enter({ characterId: PLAYER + 1, siteFamily: "abyssal" });
    r.enter({ characterId: PLAYER + 2, siteKind: "structure" });
    r.enter({ characterId: PLAYER + 3, factionId: null });
    r.enter({ characterId: PLAYER + 4, factionId: 500022 });
    r.run(40000);
    assert.strictEqual(r.sends.length, 4, "one exchange of 4 lines");
    assert.ok(r.sends.every((s) => s.characterId === PLAYER && s.systemId === SYS));
    assert.ok(r.sends[0].at >= entryAt + 4000 && r.sends[0].at < entryAt + 4000 + TICK, String(r.sends[0].at - entryAt));
    for (let i = 1; i < 4; i += 1) {
      const gap = r.sends[i].at - r.sends[i - 1].at;
      assert.ok(gap >= 3000 && gap < 9000 + TICK, `gap ${i}: ${gap}`);
    }
    const parts = r.sends.map((s) => split(s.text));
    const [a, b] = [parts[0][0], parts[1][0]];
    assert.ok(a !== b && SPEAKERS.GURISTAS.includes(a) && SPEAKERS.GURISTAS.includes(b), `${a} / ${b}`);
    assert.deepStrictEqual(parts.map((p) => p[0]), [a, b, a, b]);
    assert.strictEqual(parts[0][1], "Welcome to Jita, Bob. Lock up.", "SITE_ARRIVAL, AI, markup stripped");
    assert.ok(parts.slice(1).every((p) => AI_LINES["fv.GURISTAS.SITE_BANTER"].some((l) => l.text === p[1])));
    assert.deepStrictEqual(r.demands, ["fv.GURISTAS.SITE_ARRIVAL", "fv.GURISTAS.SITE_BANTER", "fv.GURISTAS.SITE_BANTER",
      "fv.GURISTAS.SITE_BANTER"]);

    r.enter();
    r.enter({ instanceId: 7002, roomKey: "room:2" });
    r.run(20000);
    assert.strictEqual(r.sends.length, 4, "room cooldown + character cooldown");
    const st = r.v.getStatus().site;
    assert.deepStrictEqual([st.pending, st.counters.exchanges, st.counters.done, st.counters.cooldown,
      st.counters.kindFiltered, st.counters.noFaction, st.counters.noVoice, st.counters.lines, st.counters.aiLines],
    [0, 1, 1, 3, 2, 1, 1, 4, 4]);
    assert.deepStrictEqual([r.registry.counter("npcVoices.siteEntries"), r.registry.counter("npcVoices.siteExchanges"),
      r.registry.counter("npcVoices.siteLines")], [8, 1, 4]);
    r.v.stop("test");
  });

  test("FV3-4 LEFT_SYSTEM in the middle -> ABORTED; a glyph exchange (DRIFTER) without AI; stop() aborts", () => {
    const r = rig();
    r.enter();
    for (let i = 0; i < 200 && r.sends.length < 2; i += 1) r.run(TICK);
    assert.strictEqual(r.sends.length, 2, "two lines sent");
    r.adapter.refuse = "LEFT_SYSTEM";
    r.run(20000);
    assert.strictEqual(r.sends.length, 3, "one refused attempt, then nothing");
    const st = r.v.getStatus().site;
    assert.deepStrictEqual([st.pending, st.counters.aborted, st.counters.leftSystem, st.counters.sendFailed,
      st.counters.lines], [0, 1, 1, 0, 2]);

    r.adapter.refuse = null;
    const demandsBefore = r.demands.length;
    r.enter({ characterId: PLAYER + 9, instanceId: 8001, factionId: DRIFTERS, pilotName: "Eve" });
    r.run(40000);
    const glyphs = r.sends.slice(3).map((s) => split(s.text));
    assert.strictEqual(glyphs.length, 4);
    assert.ok(glyphs.every(([label]) => SPEAKERS.DRIFTER.includes(label)));
    for (const [, text] of glyphs) {
      assert.ok([...text.replace(/ /g, "")].every((ch) => ALPHABETS.DRIFTER.includes(ch)), text);
    }
    assert.strictEqual(r.demands.length, demandsBefore, "a glyph voice never asks the AI");
    assert.strictEqual(r.v.getStatus().site.counters.glyphLines, 4);

    r.enter({ characterId: PLAYER + 10, instanceId: 8002 });
    r.run(TICK);
    assert.strictEqual(r.v.getStatus().site.pending, 1, "PLANNED");
    r.v.stop("test");
    const end = r.v.getStatus();
    assert.deepStrictEqual([end.site.state, end.site.pending, end.site.counters.aborted, r.timers.live().length,
      r.adapter.uninstalled], ["stopped", 0, 2, 0, 1]);
  });
};
