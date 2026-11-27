"use strict";

const assert = require("node:assert");

const { resolveConfig } = require("../../config");
const { chatterSettingsOf } = require("../../lib/highsecLife/schema");
const { pickLine, fillTemplate, chatterIntervalMs, PLACEHOLDERS } = require("../../lib/highsecLife/chatter");
const { toWarRumour, toBattleRumour, toGankRumour, eligibleRumours, RUMOUR_KINDS } =
  require("../../lib/highsecLife/rumours");
const { BACKGROUND, RUMOURS } = require("../../lib/highsecLife/data/chatterLines");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const { startHighsecLife, createUnavailableHighsecLife } = require("../../lib/highsecLife");
const seamModule = require("../../lib/adapter/localPilots");
const VC_DATA = require("../../lib/strategy/data/virtualCorps");
const LP = require("../localPilots/localPilots.test").harness;
const HS = require("./highsecLife.test").harness;

const MOD_DIR = require("node:path").resolve(__dirname, "..", "..");
const T0 = Date.UTC(2026, 10, 11, 17, 0, 0);
const RUMOUR_FIELDS = ["at", "attackerName", "defenderName", "key", "kind", "losses", "regionName", "systemId",
  "systemName"];

function defaultChatter(over) {
  const c = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
  return { ...c.highsecLife.chatter, ...(over || {}) };
}

function C(over) {
  const r = chatterSettingsOf({ highsecLife: { chatter: defaultChatter(over) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

function lineGraph() {
  const id = (i) => 30009000 + i;
  return { id, getNeighbors: (s) => {
    const i = s - 30009000;
    if (i < 1 || i > 12) return null;
    return [i > 1 ? id(i - 1) : null, i < 12 ? id(i + 1) : null].filter((x) => x !== null);
  } };
}

function rumour(o) {
  return { key: o.key, kind: o.kind || "SYSTEM_CAPTURED", systemId: o.systemId, at: o.at, attackerName: "Guristas",
    defenderName: "Caldari State", systemName: "Fountain-X", regionName: "Fountain", losses: null, ...o };
}

function pickInput(over) {
  return { systemId: HS.JITA, slot: 7, seed: HS.SEED, speakers: [92000101, 92000102, 92000103], lastSpeaker: null,
    place: { systemName: "Jita", regionName: "The Forge", isHub: true, hubJumps: 0 }, rumours: [],
    recentLineIds: [], C: C(), ...(over || {}) };
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

async function startChatterService(chatterOver, extra) {
  const clock = { t: T0, now() { return clock.t; } };
  const metrics = [];
  const telemetry = {};
  for (const kind of ["count", "gauge", "observe"]) telemetry[kind] = (name, value) => metrics.push([kind, name, value]);
  const sent = [];
  const notices = { calls: 0, unsub: 0, listener: null, onWarEvents(fn) {
    notices.calls += 1;
    notices.listener = fn;
    return { ok: true, unsubscribe() { notices.unsub += 1; } };
  } };
  const t = fakeTimers();
  const base = HS.baseConfig();
  const config = { ...base, highsecLife: { ...base.highsecLife, chatter: defaultChatter(chatterOver) } };
  const graph = { ...HS.fakeGraph(), getRegionName: () => "The Forge" };
  const getSystem = graph.getSystem;
  graph.getSystem = (id) => (getSystem(id) ? { ...getSystem(id), name: `S${id}` } : null);
  const vc = { ensureOwnerIdentity: () => ({ ok: true }), getOwnerIdentity: () => ({ ok: true, state: "LINKED",
    characterIds: Array.from({ length: 10 }, (_, i) => 92000000 + i), refusedMemberCount: 0 }) };
  const r = startHighsecLife({ config, worldSeed: HS.SEED, clock, telemetry, setTimer: t.setTimer,
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }), getVirtualCorps: () => vc,
    listStations: () => ({ ok: true, stations: [] }),
    bloodlinesOf: (f) => (VC_DATA.getById(f) ? VC_DATA.getById(f).bloodlineIds : null),
    getNotices: () => notices, getBattle: () => null, getGovernor: () => null,
    sendOccupantMessage: (spec) => {
      sent.push(spec);
      return { ok: true, sockets: 1 };
    }, ...(extra || {}) });
  assert.ok(r.ok, JSON.stringify(r));
  await r.highsecLife.whenReady();
  return { hs: r.highsecLife, clock, metrics, sent, notices, ...t };
}

function civilians(base, n) {
  return Array.from({ length: n }, (_, i) => base + i);
}

const K1_FINGERPRINT = "f4f8cde16da42fb2d4858ca51a7dbfe55b777be91754f3b3866f3c0673c6bc72";
const K_RUMOURS = Object.freeze([
  rumour({ key: "j:1:SYSTEM_CAPTURED", systemId: 30004001, at: 1 }),
  rumour({ key: "b:bt-1", kind: "BATTLE", systemId: 30004002, at: 1, attackerName: null, defenderName: null,
    systemName: "Fountain-Y", losses: 4 }),
]);

let kSettings = null;
function kInput(slot, over) {
  if (!kSettings) kSettings = C();
  return { systemId: 30000142 + (slot % 7), slot, seed: 4242, speakers: [92000101, 92000102, 92000103],
    lastSpeaker: slot % 3 === 0 ? 92000102 : null,
    place: { systemName: "Jita", regionName: "The Forge", isHub: slot % 2 === 0, hubJumps: slot % 2 === 0 ? 0 : 3 },
    rumours: slot % 5 === 0 ? [] : K_RUMOURS, recentLineIds: slot % 4 === 0 ? ["bg-greet-1", "bg-greet-2"] : [],
    C: kSettings, ...(over || {}) };
}

function withoutSource(r) {
  const { source, ...rest } = r;
  return rest;
}

const sha256 = (x) => require("node:crypto").createHash("sha256").update(JSON.stringify(x)).digest("hex");
const overlayOf = (permille, byKey) => ({ permille, linesOf: (key) => byKey[key] || [] });

module.exports = ({ test }) => {
  test("CH1 generator: deterministic per (system, slot), changes with the slot; rumour range / age / hub; player "
    + "kinds dropped, Rumour keys without player fields; every template fills, >= 60 background lines; no \"null\"",
  () => {
    assert.deepStrictEqual(pickLine(pickInput()), pickLine(pickInput()));
    let changed = 0;
    for (let i = 0; i < 20; i += 1) {
      const a = pickLine(pickInput({ systemId: 30000100 + i, slot: 100 + i }));
      const b = pickLine(pickInput({ systemId: 30000100 + i, slot: 101 + i }));
      assert.ok(a.ok && b.ok);
      if (a.text !== b.text || a.characterId !== b.characterId) changed += 1;
    }
    assert.ok(changed >= 1, `changed ${changed}`);
    const gap = chatterIntervalMs(80, HS.JITA, 1, HS.SEED, C({ jitterPermille: 0 }));
    assert.strictEqual(gap, 72000, "Jita (80 civilians): 240000 * 24 / 80");
    assert.strictEqual(chatterIntervalMs(2, HS.JITA, 1, HS.SEED, C({ jitterPermille: 0 })), 240000);

    const g = lineGraph();
    const S = C({ rumourPermille: 1000 });
    const now = T0;
    const near = buildHubDistance(g, [g.id(1)], S.rumourMaxJumps);
    const far = rumour({ key: "j:1:SYSTEM_CAPTURED", systemId: g.id(10), at: now - 1000 });
    const old = rumour({ key: "j:2:SYSTEM_CAPTURED", systemId: g.id(3), at: now - S.rumourMaxAgeMs - 1 });
    const close = rumour({ key: "j:3:ATTACK_STARTED", kind: "ATTACK_STARTED", systemId: g.id(3), at: now - 5000 });
    const listener = { systemId: g.id(1), isHub: false };
    assert.deepStrictEqual(eligibleRumours([far, old, close], listener, near, new Set(), now, S).map((r) => r.key),
      [close.key]);
    assert.deepStrictEqual(eligibleRumours([far, old], { ...listener, isHub: true }, near, new Set(), now, S)
      .map((r) => r.key), [far.key], "a hub hears 9 jumps away, never the old one");
    assert.deepStrictEqual(eligibleRumours([far], { ...listener, isHub: true }, near, new Set(), now,
      C({ hubRumoursAnyDistance: false })), []);
    assert.deepStrictEqual(eligibleRumours([close], listener, near, new Set([close.key]), now, S), [], "told");
    const heard = pickLine(pickInput({ rumours: [close], C: S }));
    assert.deepStrictEqual([heard.ok, heard.rumourKey], [true, close.key]);
    assert.ok(heard.text.includes("Fountain-X"), heard.text);

    const view = { eventKey: "j:9:ATTACK_STARTED", kind: "ATTACK_STARTED", systemId: 30002101, at: now,
      attackerName: "Amarr Empire", defenderName: null, systemName: "Ichoriya", regionName: "The Forge" };
    for (const kind of ["PLAYER_IMPACT", "PLAYER_SOV_SIEGE", "PLAYER_SOV_REINFORCED", "PLAYER_SOV_LOST",
      "STRUCTURE_SIEGE_STARTED", "STRUCTURE_SIEGE_ENDED", "BATTLE"]) {
      assert.strictEqual(toWarRumour({ ...view, kind }), null, kind);
    }
    const wr = toWarRumour({ ...view, characterId: 140000001, characterName: "Some Player" });
    assert.deepStrictEqual(Object.keys(wr).sort(), RUMOUR_FIELDS);
    const br = toBattleRumour({ battleId: "bt-1", systemId: 30002101, at: now, destroyedA: 2, destroyedB: 1,
      outcome: "A_WINS" }, () => ({ name: "Ichoriya", regionName: "The Forge" }), 2);
    assert.deepStrictEqual([Object.keys(br).sort(), br.key, br.losses], [RUMOUR_FIELDS, "b:bt-1", 3]);
    assert.strictEqual(toBattleRumour({ battleId: "bt-2", systemId: 30002101, at: now, destroyedA: 1,
      destroyedB: 0 }, () => ({ name: "x", regionName: null }), 2), null, "below rumourMinBattleLosses");

    const full = Object.fromEntries(PLACEHOLDERS.map((p) => [p, `v-${p}`]));
    const background = Object.values(BACKGROUND).flat();
    assert.ok(background.length >= 60, `background ${background.length}`);
    for (const t of [...background, ...Object.values(RUMOURS).flat()]) {
      const text = fillTemplate(t.text, full);
      assert.ok(text !== null && !text.includes("{"), `${t.id}: ${t.text}`);
    }
    assert.deepStrictEqual(Object.keys(RUMOURS).sort(), [...RUMOUR_KINDS].sort());
    assert.strictEqual(fillTemplate("{attacker} took {place}", { place: "X", attacker: null }), null);

    const nameless = rumour({ key: "j:4:SYSTEM_CAPTURED", systemId: g.id(2), at: now - 1, attackerName: null,
      defenderName: null });
    let told = 0;
    for (let slot = 0; slot < 50; slot += 1) {
      const p = pickLine(pickInput({ slot, rumours: [nameless], C: S }));
      assert.ok(p.ok && !p.text.includes("null") && !p.text.includes("{"), p.text);
      if (p.rumourKey !== null) {
        told += 1;
        assert.ok(p.text.includes("Fountain-X"), p.text);
      }
    }
    assert.ok(told > 0, "rumours told");
  });

  test("HG4 GANK rumour: every kind has templates, every rg template fills from {place, placeRegion, losses}; "
    + "toGankRumour has no names; eligibleRumours lets a GANK of the listener system through, not a BATTLE", () => {
    assert.ok(RUMOUR_KINDS.includes("GANK"));
    for (const kind of RUMOUR_KINDS) assert.ok((RUMOURS[kind] || []).length > 0, kind);
    assert.ok(RUMOURS.GANK.length >= 5, `rg ${RUMOURS.GANK.length}`);
    for (const t of RUMOURS.GANK) {
      assert.ok(t.id.startsWith("rg"), t.id);
      const text = fillTemplate(t.text, { place: "Uedama", placeRegion: "The Citadel", losses: "11" });
      assert.ok(text !== null && text.includes("Uedama"), `${t.id}: ${t.text}`);
    }
    const now = T0;
    const g = toGankRumour({ systemId: 30002768, bucket: 123, at: now - 1000, shipsLost: 11 },
      () => ({ name: "Uedama", regionName: "The Citadel" }));
    assert.deepStrictEqual([Object.keys(g).sort(), g.key, g.kind, g.losses, g.attackerName, g.defenderName],
      [RUMOUR_FIELDS, "g:30002768:123", "GANK", 11, null, null]);
    assert.strictEqual(toWarRumour({ eventKey: "j:1:GANK", kind: "GANK", systemId: 30002768, at: now,
      systemName: "Uedama" }), null, "a war view is never a GANK");
    const S = C({ rumourPermille: 1000 });
    const near = new Map([[30002768, 0]]);
    const battle = rumour({ key: "b:bt-9", kind: "BATTLE", systemId: 30002768, at: now - 1000, losses: 4 });
    const listener = { systemId: 30002768, isHub: false };
    assert.deepStrictEqual(eligibleRumours([g, battle], listener, near, new Set(), now, S).map((r) => r.key),
      [g.key]);
    const heard = pickLine(pickInput({ systemId: 30002768, rumours: [g], C: S,
      place: { systemName: "Uedama", regionName: "The Citadel", isHub: false, hubJumps: null } }));
    assert.deepStrictEqual([heard.ok, heard.rumourKey], [true, g.key]);
    assert.ok(heard.text.includes("Uedama") && !heard.text.includes("null"), heard.text);
  });

  test("CH2 limiter and silence: 3 systems x 30 civilians due in one tick, maxLinesPerMinute 2 -> 2 sends, "
    + "rateLimited 1, after 60 s the third; 2 civilians never speak; a war view -> rumour; flag off -> no timer, "
    + "no onWarEvents, no chatter metric", async () => {
    const env = await startChatterService({ enabled: true, maxLinesPerMinute: 2, jitterPermille: 0 });
    try {
      assert.strictEqual(env.hs.getStatus().chatter.state, "running");
      assert.deepStrictEqual([env.notices.calls, env.timers.length], [1, 1]);
      const map = new Map([[HS.JITA, civilians(92000000, 30)], [HS.PERIMETER, civilians(92000100, 30)],
        [HS.SYS_C, civilians(92000200, 30)], [HS.LOW, civilians(92000300, 2)]]);
      env.hs.noteCivilians(map, env.clock.t);
      env.fire();
      const st0 = env.hs.getStatus().chatter;
      assert.strictEqual(st0.systems, 3, "the 2-civilian system has no entry");
      env.notices.listener([{ eventKey: "j:77:SYSTEM_CAPTURED", kind: "SYSTEM_CAPTURED", systemId: 30004001,
        at: env.clock.t, attackerName: "Guristas Pirates", defenderName: "Caldari State", systemName: "Fountain-X",
        regionName: "Fountain" }, { eventKey: "j:78:PLAYER_IMPACT", kind: "PLAYER_IMPACT", systemId: 30004001,
        at: env.clock.t, attackerName: null, defenderName: null, systemName: "Fountain-X", regionName: null }]);
      const sent0 = env.sent.length;
      const limited0 = st0.counters.rateLimited;
      env.clock.t += 200000;
      env.fire();
      let st = env.hs.getStatus().chatter;
      assert.deepStrictEqual([env.sent.length - sent0, st.counters.rateLimited - limited0], [2, 1]);
      assert.deepStrictEqual([st.warRumours, st.counters.warRumoursAdded, st.counters.rumoursRejected], [1, 1, 1]);
      env.clock.t += 60000;
      env.fire();
      st = env.hs.getStatus().chatter;
      assert.deepStrictEqual([env.sent.length - sent0, st.counters.rateLimited - limited0], [3, 1], "after 60 s");
      assert.ok(env.sent.every((s) => s.systemId !== HS.LOW), "fewer than minCivilians: silent");
      assert.ok(env.sent.every((s) => map.get(s.systemId).includes(s.characterId) && s.text.length > 0));
      assert.strictEqual(st.counters.lines, env.sent.length);
      const names = new Set(env.metrics.map((m) => m[1]));
      assert.ok(names.has("highsecLife.chatterLines") && names.has("highsecLife.chatterRateLimited")
        && names.has("highsecLife.chatterPassMs"), [...names].join(","));
      env.hs.stop();
      assert.deepStrictEqual([env.hs.getStatus().chatter.state, env.notices.unsub, env.hs.getStatus().chatter.systems],
        ["stopped", 1, 0]);
    } finally {
      env.hs.stop();
    }

    const off = await startChatterService({ enabled: false });
    try {
      off.hs.noteCivilians(new Map([[HS.JITA, civilians(92000000, 30)]]), off.clock.t);
      assert.deepStrictEqual([off.timers.length, off.notices.calls, off.hs.getStatus().chatter.state], [0, 0, "off"]);
      assert.deepStrictEqual(off.metrics.filter((m) => m[1].startsWith("highsecLife.chatter")), []);
    } finally {
      off.hs.stop();
    }
  });

  test("CH6 localPilots push +: noteCivilians gets the civilian ids only; the fake highsecLife stops -> one "
    + "civiliansWanted 0 / civiliansAssigned 0, then nothing; facade keys = stub keys; the seam has "
    + "sendOccupantMessage", async () => {
    const SYS_A = HS.SYS_C;
    const SYS_B = HS.PERIMETER;
    const w = LP.world();
    const civIds = civilians(92000500, 6);
    for (const id of civIds) w.records.set(id, { corporationID: 98500001, allianceID: 0 });
    const notes = [];
    const fake = { state: "running", getStatus: () => ({ state: fake.state }),
      civilianTargets: () => ({ ok: true, bucket: 1, targets: new Map([[SYS_A, 4], [SYS_B, 2]]) }),
      civilianOrder: (ids) => ids.slice(), civilianChurn: () => new Set(),
      noteCivilians: (m, at) => notes.push([m, at]) };
    const clock = { t: T0, now() { return clock.t; } };
    const metrics = [];
    const telemetry = {};
    for (const kind of ["count", "gauge", "observe"]) telemetry[kind] = (name, value) => metrics.push([kind, name, value]);
    try {
      const env = LP.boot({ world: w, clock, telemetry, highsecLife: fake, settings: { maxPilotsPerSystem: 12 },
        presenceState: { observed: [SYS_A, SYS_B] }, fleets: new Map([[SYS_B, [LP.fleet(LP.FACTION, null, 3)]]]),
        virtualCorps: { listCivilianCandidates: () => ({ ok: true, version: 1, characterIds: civIds }) } });
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      assert.strictEqual(notes.length, 1);
      const [pushed, at] = notes[0];
      assert.strictEqual(at, T0);
      const civSet = new Set(civIds);
      assert.deepStrictEqual([...pushed.keys()].sort((a, b) => a - b), [SYS_B, SYS_A].sort((a, b) => a - b));
      assert.deepStrictEqual([pushed.get(SYS_A).length, pushed.get(SYS_B).length], [4, 2]);
      for (const ids of pushed.values()) {
        assert.ok(ids.every((id) => civSet.has(id)), `civilians only: ${ids}`);
        assert.deepStrictEqual(ids, ids.slice().sort((a, b) => a - b));
      }
      const gauge = (name) => metrics.filter((m) => m[0] === "gauge" && m[1] === name).map((m) => m[2]);
      assert.deepStrictEqual([gauge("highsecLife.civiliansWanted"), gauge("highsecLife.civiliansAssigned")],
        [[6], [6]]);
      fake.state = "stopped";
      env.lp.runPassNow();
      env.lp.runPassNow();
      assert.deepStrictEqual([gauge("highsecLife.civiliansWanted"), gauge("highsecLife.civiliansAssigned")],
        [[6, 0], [6, 0]], "one 0 each, then nothing");
      assert.strictEqual(notes.length, 1, "highsecLife not running: no push");
      env.lp.stop("test");
    } finally {
      seamModule._resetForTest();
    }

    const env2 = await startChatterService({ enabled: false });
    try {
      const stub = createUnavailableHighsecLife("disabled_by_config");
      assert.deepStrictEqual(Object.keys(env2.hs).sort(), Object.keys(stub).sort());
      assert.ok(Object.keys(stub).includes("noteCivilians"));
      assert.strictEqual(stub.noteCivilians(new Map(), 0), undefined);
    } finally {
      env2.hs.stop();
    }
    const seam = seamModule.createLocalPilotsSeam({ requireGame: () => ({ ok: false, reason: "x" }) });
    assert.strictEqual(typeof seam.sendOccupantMessage, "function");
  });

  test("K1: pickLine without ai / ai null / permille 0 = the result on 200 slots "
    + "(fingerprint), source static, linesOf never asked", () => {
    let asked = 0;
    const zero = { permille: 0, linesOf: () => {
      asked += 1;
      return [{ id: "ai-hs.bg.GREETING-1", text: "Hello {system}, fly safe" }];
    } };
    const plain = [];
    for (let slot = 0; slot < 200; slot += 1) {
      const a = pickLine(kInput(slot));
      assert.deepStrictEqual(pickLine(kInput(slot, { ai: null })), a, `ai null, slot ${slot}`);
      assert.deepStrictEqual(pickLine(kInput(slot, { ai: zero })), a, `permille 0, slot ${slot}`);
      assert.strictEqual(a.source, "static");
      plain.push(withoutSource(a));
    }
    assert.strictEqual(asked, 0);
    assert.ok(plain.some((p) => p.rumourKey !== null) && plain.some((p) => p.rumourKey === null), "both branches");
    assert.strictEqual(sha256(plain), K1_FINGERPRINT, "the draws [1]-[7] did not move");
  });

  test("K2: permille 1000 -> the AI template of the bucket of the static line (filled, ai "
    + "source ai, same speaker / rumourKey); a template that does not fill, too long or a throwing linesOf -> static",
  () => {
    const greetIds = new Set(BACKGROUND.GREETING.map((t) => t.id));
    const hello = overlayOf(1000, { "hs.bg.GREETING": [{ id: "ai-hs.bg.GREETING-1", text: "Hello {system}, fly safe" }],
      "hs.rumour.SYSTEM_CAPTURED": [{ id: "ai-hs.rumour.SYSTEM_CAPTURED-1", text: "{attacker} now holds {place}" }] });
    let greet = 0;
    let told = 0;
    for (let slot = 0; slot < 200; slot += 1) {
      const s = pickLine(kInput(slot));
      const a = pickLine(kInput(slot, { ai: hello }));
      assert.deepStrictEqual([a.characterId, a.rumourKey], [s.characterId, s.rumourKey], `slot ${slot}`);
      if (greetIds.has(s.lineId)) {
        greet += 1;
        assert.deepStrictEqual([a.text, a.lineId, a.source], ["Hello Jita, fly safe", "ai-hs.bg.GREETING-1", "ai"]);
      } else if (s.rumourKey === "j:1:SYSTEM_CAPTURED") {
        told += 1;
        assert.deepStrictEqual([a.text, a.source], ["Guristas now holds Fountain-X", "ai"]);
        assert.ok(a.lineId.startsWith("ai-"));
      } else {
        assert.deepStrictEqual(a, s, `other bucket, slot ${slot}`);
      }
    }
    assert.ok(greet > 0 && told > 0, `greet ${greet}, told ${told}`);
    const slots = Array.from({ length: 200 }, (_, slot) => slot).filter((slot) => !kInput(slot).rumours.length);
    const bad = [
      overlayOf(1000, { "hs.bg.GREETING": [{ id: "ai-hs.bg.GREETING-2", text: "{attacker} says hi to {system}" }] }),
      overlayOf(1000, { "hs.bg.GREETING": [{ id: "ai-hs.bg.GREETING-3", text: `Hello ${"o".repeat(300)}` }] }),
      { permille: 1000, linesOf: () => { throw new Error("pool broke"); } },
      { permille: 1000, linesOf: () => "not an array" },
    ];
    for (const ai of bad) {
      for (const slot of slots) {
        const s = pickLine(kInput(slot));
        assert.deepStrictEqual(pickLine(kInput(slot, { ai })), s, `slot ${slot}`);
      }
    }
  });

  test("K4 service: getChatterAi overlay() that throws -> lines still sent, aiLines 0, no "
    + "chatterAiLines; a working overlay -> aiLines > 0 = the chatterAiLines metric", async () => {
    const run = async (getChatterAi) => {
      const env = await startChatterService({ enabled: true, maxLinesPerMinute: 60, jitterPermille: 0 },
        { getChatterAi });
      try {
        env.hs.noteCivilians(new Map([[HS.JITA, civilians(92000000, 30)], [HS.PERIMETER, civilians(92000100, 30)],
          [HS.SYS_C, civilians(92000200, 30)]]), env.clock.t);
        for (let k = 0; k < 6; k += 1) {
          env.fire();
          env.clock.t += 200000;
        }
        const aiMetric = env.metrics.filter((m) => m[1] === "highsecLife.chatterAiLines");
        return { st: env.hs.getStatus().chatter, sent: env.sent, aiMetric };
      } finally {
        env.hs.stop();
      }
    };
    const broken = await run(() => ({ overlay() { throw new Error("overlay broke"); } }));
    assert.ok(broken.sent.length > 0, "the static lines still go out");
    assert.deepStrictEqual([broken.st.counters.aiLines, broken.aiMetric.length], [0, 0]);
    const keys = [...Object.keys(BACKGROUND).map((c) => `hs.bg.${c}`), ...Object.keys(RUMOURS).map((k) => `hs.rumour.${k}`)];
    const pool = Object.fromEntries(keys.map((k) => [k, [{ id: `ai-${k}-1`, text: "K4 marker quiet day in {system}" }]]));
    const good = await run(() => ({ overlay: () => ({ ok: true, permille: 1000, linesOf: (k) => pool[k] || [] }) }));
    const aiSent = good.sent.filter((s) => s.text.startsWith("K4 marker "));
    assert.ok(good.st.counters.aiLines > 0, JSON.stringify(good.st.counters));
    assert.deepStrictEqual([aiSent.length, good.aiMetric.reduce((n, m) => n + m[2], 0)],
      [good.st.counters.aiLines, good.st.counters.aiLines]);
    const refused = await run(() => ({ overlay: () => ({ ok: false, reason: "EMPTY" }) }));
    assert.deepStrictEqual(refused.sent, broken.sent, "a refusing overlay = the throwing one = the static lines");
  });
};
