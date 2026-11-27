"use strict";

const assert = require("node:assert");

const { resolveConfig } = require("../../config");
const { startHighsecLife, createUnavailableHighsecLife } = require("../../lib/highsecLife");
const freeCorpsChatter = require("../../lib/freeCorps/chatter");
const VC_DATA = require("../../lib/strategy/data/virtualCorps");
const HS = require("./highsecLife.test").harness;

const MOD_DIR = require("node:path").resolve(__dirname, "..", "..");
const T0 = Date.UTC(2026, 10, 12, 17, 0, 0);
const NS = 30004001;
const A = 93000001;
const B = 93000002;
const C = 93000003;

function speaker(characterId) {
  return Object.freeze({ characterId, corpId: 7, corpName: "Null Diggers", ticker: "NDIG", archetype: "miner",
    homeSystemId: NS, role: "HOME", venture: null, last: null });
}

function fakeFreeCorps() {
  const fc = { speakers: 0, news: 0,
    chatterSpeakers(systemId, at) {
      fc.speakers += 1;
      assert.ok(Number.isSafeInteger(systemId) && Number.isFinite(at));
      return { ok: true, speakers: [speaker(A), speaker(B), speaker(C)] };
    },
    ventureNews() {
      fc.news += 1;
      return { ok: true, items: [], full: false };
    } };
  return fc;
}

function fakeTimers() {
  const timers = [];
  const setTimer = (fn, ms) => {
    const t = { ms, cancelled: false, fn, cancel() { t.cancelled = true; }, hasRef: () => false };
    timers.push(t);
    return t;
  };
  const fire = () => {
    const t = timers.filter((x) => !x.cancelled).pop();
    assert.ok(t, "an armed timer");
    t.cancelled = true;
    t.fn();
  };
  return { timers, setTimer, fire };
}

async function start({ chatter, freeCorps, deps }) {
  const clock = { t: T0, now() { return clock.t; } };
  const metrics = [];
  const telemetry = {};
  for (const kind of ["count", "gauge", "observe"]) telemetry[kind] = (name, value) => metrics.push([kind, name, value]);
  const sent = [];
  const t = fakeTimers();
  const base = HS.baseConfig();
  const config = { ...base, highsecLife: { ...base.highsecLife, chatter: { ...base.highsecLife.chatter,
    enabled: true, jitterPermille: 0, ...(chatter || {}) } },
  freeCorps: { ...base.freeCorps, ...(freeCorps || {}), chatter: { ...base.freeCorps.chatter,
    ...((freeCorps && freeCorps.chatter) || {}) } } };
  const graph = { ...HS.fakeGraph(), getRegionName: () => "The Forge" };
  const getSystem = graph.getSystem;
  graph.getSystem = (id) => (getSystem(id) ? { ...getSystem(id), name: `S${id}` } : null);
  const vc = { ensureOwnerIdentity: () => ({ ok: true }), getOwnerIdentity: () => ({ ok: true, state: "LINKED",
    characterIds: Array.from({ length: 10 }, (_, i) => 92000000 + i), refusedMemberCount: 0 }) };
  const r = startHighsecLife({ config, worldSeed: HS.SEED, clock, telemetry, setTimer: t.setTimer, nowMs: () => 0,
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }), getVirtualCorps: () => vc,
    listStations: () => ({ ok: true, stations: [] }),
    bloodlinesOf: (f) => (VC_DATA.getById(f) ? VC_DATA.getById(f).bloodlineIds : null),
    getNotices: () => null, getBattle: () => null, getGovernor: () => null,
    sendOccupantMessage: (spec) => {
      sent.push(spec);
      return { ok: true, sockets: 1 };
    }, ...(deps || {}) });
  assert.ok(r.ok, JSON.stringify(r));
  await r.highsecLife.whenReady();
  return { hs: r.highsecLife, clock, metrics, sent, ...t };
}

const FC_ON = Object.freeze({ enabled: true, chatter: { enabled: true } });
const civilians = (base, n) => Array.from({ length: n }, (_, i) => base + i);

module.exports = ({ test }) => {
  test("FC5-2 resident lane: nullsec without civilians, only shown residents speak, hourly cap 2 of 10 deadlines, "
    + "the shared limiter gives the token to the civilian first", async () => {
    const fc = fakeFreeCorps();
    const env = await start({ chatter: { minIntervalMs: 60000, maxLinesPerMinute: 60 },
      freeCorps: { ...FC_ON, chatter: { enabled: true, maxLinesPerSystemPerHour: 2 } },
      deps: { getFreeCorps: () => fc, freeCorpsChatter } });
    try {
      assert.strictEqual(env.hs.getStatus().chatter.residents.state, "running");
      env.hs.noteResidents(new Map([[NS, [B, A]]]), env.clock.t);
      for (let k = 0; k < 11; k += 1) {
        env.fire();
        env.clock.t += 60000;
      }
      const st = env.hs.getStatus().chatter.residents;
      assert.strictEqual(env.sent.length, 2, JSON.stringify(env.sent));
      assert.ok(env.sent.every((s) => s.systemId === NS && (s.characterId === A || s.characterId === B)
        && s.text.length > 0), JSON.stringify(env.sent));
      assert.ok(st.counters.hourLimited >= 1 && st.counters.lines === 2, JSON.stringify(st.counters));
      assert.ok(fc.news >= 1, "ventureNews polled");
      const names = new Set(env.metrics.map((m) => m[1]));
      assert.ok(names.has("highsecLife.chatterResidentLines") && names.has("highsecLife.chatterResidentHourLimited"),
        [...names].join(","));
    } finally {
      env.hs.stop();
    }
    assert.strictEqual(env.hs.getStatus().chatter.residents.state, "stopped");

    const shared = await start({ chatter: { maxLinesPerMinute: 1 }, freeCorps: FC_ON,
      deps: { getFreeCorps: () => fakeFreeCorps(), freeCorpsChatter } });
    try {
      const civ = civilians(92000000, 30);
      shared.hs.noteCivilians(new Map([[HS.JITA, civ]]), shared.clock.t);
      shared.hs.noteResidents(new Map([[NS, [A, B]]]), shared.clock.t);
      shared.fire();
      const sent0 = shared.sent.length;
      const limited0 = shared.hs.getStatus().chatter.residents.counters.rateLimited;
      shared.clock.t += 600000;
      shared.fire();
      const fresh = shared.sent.slice(sent0);
      assert.deepStrictEqual(fresh.map((s) => [s.systemId, civ.includes(s.characterId)]), [[HS.JITA, true]]);
      assert.strictEqual(shared.hs.getStatus().chatter.residents.counters.rateLimited - limited0, 1);
    } finally {
      shared.hs.stop();
    }
  });

  test("K4b resident lane: a working getChatterAi overlay -> residents.counters.aiLines > 0 = "
    + "the chatterAiLines metric, the civilian aiLines untouched", async () => {
    const ai = { overlay: () => ({ ok: true, permille: 1000,
      linesOf: (key) => (key.startsWith("fc.") ? [{ id: `ai-${key}-1`, text: "K4b {corp} says hello" }] : []) }) };
    const env = await start({ chatter: { minIntervalMs: 60000, maxLinesPerMinute: 60 }, freeCorps: FC_ON,
      deps: { getFreeCorps: () => fakeFreeCorps(), freeCorpsChatter, getChatterAi: () => ai } });
    try {
      env.hs.noteResidents(new Map([[NS, [A, B]]]), env.clock.t);
      for (let k = 0; k < 6; k += 1) {
        env.fire();
        env.clock.t += 600000;
      }
      const st = env.hs.getStatus().chatter;
      const aiSent = env.sent.filter((s) => s.text === "K4b Null Diggers says hello");
      const aiMetric = env.metrics.filter((m) => m[1] === "highsecLife.chatterAiLines").reduce((n, m) => n + m[2], 0);
      assert.ok(st.residents.counters.aiLines > 0, JSON.stringify(st.residents.counters));
      assert.deepStrictEqual([aiSent.length, aiMetric, st.counters.aiLines], [st.residents.counters.aiLines,
        st.residents.counters.aiLines, 0]);
    } finally {
      env.hs.stop();
    }
  });

  test("FC5-3 flag off bit for bit: 30 ticks without getFreeCorps vs freeCorps.chatter off with a spy and "
    + "noteResidents -> the same sends, 0 calls, the same status keys; stub noteResidents; defaults and W13-W15",
  async () => {
    const run = async (variant) => {
      const env = await start({ chatter: { maxLinesPerMinute: 4 }, ...variant });
      try {
        env.hs.noteCivilians(new Map([[HS.JITA, civilians(92000000, 30)], [HS.SYS_C, civilians(92000100, 12)]]),
          env.clock.t);
        if (typeof env.hs.noteResidents === "function") env.hs.noteResidents(new Map([[NS, [A, B]]]), env.clock.t);
        for (let k = 0; k < 30; k += 1) {
          env.fire();
          env.clock.t += 45000;
        }
        return { sent: env.sent, keys: Object.keys(env.hs.getStatus().chatter), metrics: env.metrics };
      } finally {
        env.hs.stop();
      }
    };
    const a = await run({});
    const spy = fakeFreeCorps();
    let spyGets = 0;
    const b = await run({ freeCorps: { enabled: true, chatter: { enabled: false } },
      deps: { getFreeCorps: () => { spyGets += 1; return spy; }, freeCorpsChatter } });
    assert.ok(a.sent.length > 0, "the civilians spoke");
    assert.deepStrictEqual(b.sent, a.sent);
    assert.deepStrictEqual(b.keys, a.keys);
    assert.ok(!a.keys.includes("residents"));
    assert.deepStrictEqual(b.metrics, a.metrics);
    assert.deepStrictEqual([spyGets, spy.speakers, spy.news], [0, 0, 0]);
    const stub = createUnavailableHighsecLife("disabled_by_config");
    assert.strictEqual(typeof stub.noteResidents, "function");
    assert.strictEqual(stub.noteResidents(new Map(), 0), undefined);

    const def = resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.deepStrictEqual({ ...def.config.freeCorps.chatter }, { enabled: false, maxLinesPerSystemPerHour: 4,
      minResidents: 1, newsPollMs: 60000, newsReadLimit: 64, rumourMinYieldIsk: 150000000, rumourMinCrewLost: 1 });
    const W = (r) => r.warnings.filter((w) => w.startsWith("freeCorps.chatter.enabled"));
    assert.deepStrictEqual(W(def), []);
    const on = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FREE_CORPS_CHATTER_ENABLED: "1" } });
    assert.strictEqual(W(on).length, 3, W(on).join("; "));
    const all = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FREE_CORPS_CHATTER_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1", EVEJS_LNE_FREE_CORPS_LOCAL_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_VENTURES_ENABLED: "1", EVEJS_LNE_LOCAL_PILOTS_ENABLED: "1",
      EVEJS_LNE_HIGHSEC_LIFE_ENABLED: "1", EVEJS_LNE_HIGHSEC_LIFE_CIVILIANS_ENABLED: "1",
      EVEJS_LNE_HIGHSEC_LIFE_CHATTER_ENABLED: "1" } });
    assert.deepStrictEqual(W(all), [], W(all).join("; "));
  });
};
