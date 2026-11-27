"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { TRIGGER_TEXT, ABYSSAL_FAIL_TEXT, TRIGGER_PRIORITY } = require("../../lib/shipAi/data/triggers");
const { planAbyssal, parseWarnList } = require("../../lib/shipAi/abyssalLines");
const { createProactive, PRIORITY } = require("../../lib/shipAi/proactive");
const { FAILED_OUTCOMES } = require("../../lib/abyssal/machine");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PLAYER = 9001;
const OTHER = 9002;
const T0 = 1700000000000;
const MIN = 60000;
const B = 30000002;
const NOTIMER = () => ({ cancel() {}, hasRef: () => false });
const SET = Object.freeze({ abyssalWarnAtMs: [300000, 60000], abyssalSeenMax: 32, language: "en" });

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const run = (over) => ({ instanceId: 7, activatedAtMs: T0, ownerCharacterId: PLAYER,
  participants: [{ characterId: PLAYER }], tier: 2, weather: "Electrical", pocketsCompleted: 0,
  expiresAtMs: T0 + 20 * MIN, state: "ACTIVE", vendorOutcome: null, ...(over || {}) });

function stepper(settingsOver) {
  let state = null;
  return (runs, at) => {
    const out = planAbyssal(state, { runs }, PLAYER, at, { ...SET, ...(settingsOver || {}) });
    state = out.state;
    return out.entries;
  };
}
const keysOf = (entries) => entries.map((e) => e.key.split(":").slice(3).join(":"));

function proactiveRig(over, abyssalRuns) {
  let now = T0;
  const delivered = [];
  const keys = new Set();
  const logs = [];
  const toolDeps = { telemetry: () => ({ ok: true, docked: false, shipTypeId: 587, armorPermille: 1000,
    structurePermille: 1000, capacitorPermille: 900, warping: false }), typeName: () => null,
  itemByName: () => ({ ok: true, found: false }), graph: () => null, crimeFlags: () => ({ ok: true, found: false }),
  securityStatus: () => ({ ok: true, securityStatus: 1 }), abyssalRuns };
  const eventsRepo = { noteEventInTx: (_db, spec) => {
    if (!S.EVENT_KINDS.includes(spec.kind)) return { ok: false, reason: "BAD_KIND" };
    const fresh = !keys.has(spec.key);
    keys.add(spec.key);
    return { ok: true, inserted: fresh };
  }, markMentionedInTx: () => ({ ok: true, changed: 0 }), listPendingPods: () => ({ ok: true, playerIds: [] }) };
  const p = createProactive({ S: settings({ language: "pl", calloutEnabled: false, worldNewsEnabled: false,
    battleHereEnabled: false, eventHereEnabled: false, ...(over || {}) }),
  maxIdentities: 4, store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
  prefsRepo: { setLastProactive: () => ({ ok: true }) }, eventsRepo,
  adapter: { readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER, name: "P", systemId: B,
    state: "space" }] }) }, seam: null, toolDeps,
  client: { request: () => Promise.resolve({ ok: false, reason: "TIMEOUT" }) },
  deliver: (_id, lines) => {
    delivered.push(...lines);
    return { room: lines.length, system: 0, failed: 0 };
  }, nameOf: () => "Jin", isWatched: (id) => id === PLAYER, isAllowed: () => true,
  staticIndex: () => new Map([[B, { name: "Bej", security: "nullsec", region: "R", regionId: 1 }]]),
  snapshot: () => ({ json: "{}", presence: null }), initialPrefs: new Map([[PLAYER, { quiet: false,
    lastProactiveAt: null }]]), nowMs: () => now, setTimer: NOTIMER, logger: { log: (l) => logs.push(l) } });
  const pass = (ms) => {
    now += ms === undefined ? 5000 : ms;
    p.runPass();
  };
  return { p, pass, delivered, keys, logs, now: () => now };
}

const filled = (lines, values) => lines.map((l) => l.replace(/\{(\w+)\}/g, (_m, k) => values[k]));

module.exports = ({ test }) => {
  test("ABL1 planAbyssal: baseline, room 1, the 5 min and 1 min warnings once, FAILED reason, another player, no "
    + "expiry = no warning", () => {
    const step = stepper();
    assert.deepStrictEqual(step([run()], T0 + MIN), [], "the first read is the baseline");
    const room = step([run({ pocketsCompleted: 1 })], T0 + 2 * MIN);
    assert.deepStrictEqual(keysOf(room), ["room:1"]);
    assert.deepStrictEqual([room[0].kind, room[0].priority, room[0].model, room[0].template, room[0].values],
      ["ABYSSAL", 78, false, "ABYSSAL_ROOM", { room: 1, rooms: 3 }]);
    const warn5 = step([run({ pocketsCompleted: 1 })], T0 + 16 * MIN);
    assert.deepStrictEqual([keysOf(warn5), warn5[0].template, warn5[0].values], [["warn:300000"], "ABYSSAL_WARN",
      { minutes: 4 }]);
    const warn1 = step([run({ pocketsCompleted: 1 })], T0 + 20 * MIN - 50000);
    assert.deepStrictEqual([keysOf(warn1), warn1[0].template, warn1[0].values], [["warn:60000"],
      "ABYSSAL_WARN_SECONDS", { seconds: 50 }]);
    assert.deepStrictEqual(step([run({ pocketsCompleted: 1 })], T0 + 20 * MIN - 40000), [], "nothing again");
    const failed = step([run({ pocketsCompleted: 1, state: "FAILED", vendorOutcome: "failed_timeout" })],
      T0 + 20 * MIN + 1000);
    assert.deepStrictEqual([keysOf(failed), failed[0].template, failed[0].values], [["failed"], "ABYSSAL_FAILED",
      { reason: "the time ran out" }]);
    const unknown = step([run({ instanceId: 8, state: "FAILED", vendorOutcome: "something_new" })], T0 + 21 * MIN);
    assert.deepStrictEqual([keysOf(unknown), unknown[0].template], [["failed"], "ABYSSAL_FAILED_PLAIN"],
      "an unknown vendor code = the plain line; a closed run has no enter");
    const other = stepper();
    other([], T0);
    assert.deepStrictEqual(other([run({ ownerCharacterId: OTHER, participants: [{ characterId: OTHER }] })],
      T0 + MIN), [], "a run of another player");
    const fleet = other([run({ ownerCharacterId: OTHER, participants: [{ characterId: OTHER },
      { characterId: PLAYER }], expiresAtMs: 0 })], T0 + 2 * MIN);
    assert.deepStrictEqual([keysOf(fleet), fleet[0].template], [["enter"], "ABYSSAL_ENTER_PLAIN"],
      "a fleet member hears the enter; no expiry = no minutes");
    assert.deepStrictEqual(other([run({ ownerCharacterId: OTHER, participants: [{ characterId: PLAYER }],
      expiresAtMs: 0 })], T0 + 30 * MIN), [], "expiresAtMs 0 = no warning");
    for (const lang of ["pl", "en"]) {
      for (const code of FAILED_OUTCOMES) assert.ok(ABYSSAL_FAIL_TEXT[lang][code], `${lang} ${code}`);
    }
  });

  test("ABL2 restart baseline in the 12th minute, two marks at once = the smallest, parseWarnList", () => {
    const step = stepper();
    assert.deepStrictEqual(step([run({ pocketsCompleted: 2 })], T0 + 12 * MIN), [], "a restart tells no past");
    assert.deepStrictEqual(keysOf(step([run({ pocketsCompleted: 2 })], T0 + 15 * MIN + 1)), ["warn:300000"],
      "the future mark speaks");
    const late = stepper();
    late([], T0);
    const enter = late([run()], T0 + MIN);
    assert.deepStrictEqual([keysOf(enter), enter[0].template, enter[0].values], [["enter"], "ABYSSAL_ENTER",
      { tier: 2, weather: "Electrical", minutes: 19 }]);
    const both = late([run()], T0 + 20 * MIN - 30000);
    assert.deepStrictEqual(keysOf(both), ["warn:60000"], "only the most urgent of two crossed marks");
    assert.deepStrictEqual(late([run()], T0 + 20 * MIN - 20000), [], "the bigger one is seen silently");
    const exited = late([run({ state: "EXITED" })], T0 + 20 * MIN);
    assert.deepStrictEqual([keysOf(exited), exited[0].template], [["exited"], "ABYSSAL_EXITED"]);
    const lost = late([run({ instanceId: 9, state: "LOST" })], T0 + 21 * MIN);
    assert.deepStrictEqual(lost, [], "LOST says nothing");
    const many = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => run({ instanceId: i, pocketsCompleted: 2 }));
    const capped = planAbyssal({ seen: new Map() }, { runs: many }, PLAYER, T0 + MIN, { ...SET, abyssalSeenMax: 8 });
    assert.deepStrictEqual([capped.entries.length, capped.state.seen.size], [30, 30],
      "The keys of the current reading are never evicted");
    const gone = planAbyssal(capped.state, { runs: [many[0]] }, PLAYER, T0 + 2 * MIN, { ...SET, abyssalSeenMax: 8 });
    assert.deepStrictEqual([gone.entries.length, gone.state.seen.size], [0, 8], "the gone runs leave first (FIFO)");
    assert.ok(["enter", "room:1", "room:2"].every((s) => gone.state.seen.has(`aby:1:${T0}:${s}`)), "the live run stays");

    assert.deepStrictEqual(parseWarnList("60000, 300000,60000"), [300000, 60000]);
    assert.deepStrictEqual(parseWarnList(""), []);
    assert.deepStrictEqual(parseWarnList("10000,20000,30000,40000"), [40000, 30000, 20000, 10000]);
    for (const bad of ["9999", "1200001", "1,2", "60000,x", "1.5", "10000,20000,30000,40000,50000", null]) {
      assert.strictEqual(parseWarnList(bad), null, String(bad));
    }
    const cfg = (v) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ABYSSAL_WARN_AT_MS: v } });
    const badCfg = cfg("5");
    assert.strictEqual(badCfg.config.shipAi.abyssalWarnAtMs, "300000,60000", "a bad list = the default");
    assert.ok(badCfg.warnings.some((w) => w.includes("EVEJS_LNE_SHIP_AI_ABYSSAL_WARN_AT_MS")),
      JSON.stringify(badCfg.warnings));
    assert.strictEqual(cfg("120000").config.shipAi.abyssalWarnAtMs, "120000");
  });

  test("ABL5: abyssalSeenMax 8, 4 marks, an open + a finished run (10 keys) = no repeat; min 16", () => {
    const S8 = { abyssalWarnAtMs: [300000, 240000, 120000, 60000], abyssalSeenMax: 8, language: "en" };
    const open = run({ pocketsCompleted: 2, expiresAtMs: T0 + 20 * MIN });
    const finished = run({ instanceId: 8, pocketsCompleted: 2, state: "EXITED" });
    const at = T0 + 20 * MIN - 50000;
    const first = planAbyssal({ seen: new Map() }, { runs: [open, finished] }, PLAYER, at, S8);
    assert.deepStrictEqual([first.entries.length, first.state.seen.size], [7, 10], "3 warning marks silent");
    const second = planAbyssal(first.state, { runs: [open, finished] }, PLAYER, at + 5000, S8);
    assert.deepStrictEqual(second.entries, [], "the second reading says nothing again");
    const cfg = (v) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ABYSSAL_SEEN_MAX: v } }).config;
    assert.deepStrictEqual([cfg("8").shipAi.abyssalSeenMax, cfg("16").shipAi.abyssalSeenMax], [16, 16], "min 16");
  });

  test("ABL3 the pass: off = no read; on = the line without an events row; muted = triggerMuted; kind lists", () => {
    let calls = 0;
    let runs = [];
    const reader = () => {
      calls += 1;
      return { ok: true, runs };
    };
    const off = proactiveRig({ abyssalLinesEnabled: false }, reader);
    off.p.start();
    for (let i = 0; i < 3; i += 1) off.pass();
    assert.strictEqual(calls, 0, "abyssalLinesEnabled off: no read of ctx.abyssal");
    off.p.stop();

    const on = proactiveRig({ abyssalLinesEnabled: true }, reader);
    on.p.start();
    on.pass();
    on.pass();
    assert.deepStrictEqual(on.delivered, [], JSON.stringify(on.logs));
    runs = [run({ expiresAtMs: on.now() + 5000 + 20 * MIN })];
    on.pass();
    const enterLines = filled(TRIGGER_TEXT.pl.ABYSSAL_ENTER, { tier: 2, weather: "Electrical", minutes: 20 });
    assert.ok(on.delivered.length === 1 && enterLines.includes(on.delivered[0]), JSON.stringify(on.delivered));
    const st = on.p.getStatus();
    assert.deepStrictEqual([st.counters.abyssalLines, st.byKind.ABYSSAL, st.counters.abyssalReads > 0,
      st.counters.abyssalFailed], [1, 1, true, 0]);
    assert.ok(![...on.keys].some((k) => k.startsWith("aby:")), "no ship_ai_events row of a RAM kind");
    on.pass();
    assert.strictEqual(on.delivered.length, 1, "the same reading says nothing again");
    on.p.stop();

    runs = [];
    const muted = proactiveRig({ abyssalLinesEnabled: true, triggersDisabledKinds: "ABYSSAL" }, reader);
    muted.p.start();
    muted.pass();
    muted.pass();
    runs = [run({ expiresAtMs: muted.now() + 5000 + 20 * MIN })];
    muted.pass();
    assert.deepStrictEqual(muted.delivered, []);
    assert.ok(muted.p.getStatus().counters.triggerMuted >= 1);
    muted.p.stop();

    const refused = proactiveRig({ abyssalLinesEnabled: true }, () => ({ ok: false, reason: "ABYSSAL_UNAVAILABLE" }));
    refused.p.start();
    refused.pass();
    refused.pass();
    assert.deepStrictEqual([refused.p.getStatus().counters.abyssalFailed >= 1, refused.delivered],
      [true, []]);
    assert.ok(refused.logs.some((l) => l.includes("abyssalRuns refused") && l.includes("ABYSSAL_UNAVAILABLE")),
      JSON.stringify(refused.logs));
    refused.p.stop();

    assert.deepStrictEqual([PRIORITY.ABYSSAL, TRIGGER_PRIORITY.ABYSSAL], [78, 78]);
    assert.ok(S.MUTE_KINDS.includes("ABYSSAL") && S.RAM_TRIGGER_KINDS.includes("ABYSSAL"));
    assert.ok(!S.EVENT_KINDS.includes("ABYSSAL"), "no migration: the CHECK of ship_ai_events stays");
    const mutedCfg = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_TRIGGERS_DISABLED_KINDS: "abyssal" } });
    assert.strictEqual(mutedCfg.config.shipAi.triggersDisabledKinds, "abyssal", "the literal copy takes ABYSSAL");
    const warned = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ABYSSAL_LINES_ENABLED: "1" } }).warnings;
    assert.ok(warned.some((w) => w.startsWith("shipAi.abyssalLinesEnabled without abyssal.enabled")));
    for (const lang of ["pl", "en"]) {
      for (const k of ["ABYSSAL_ENTER", "ABYSSAL_ENTER_PLAIN", "ABYSSAL_WARN", "ABYSSAL_WARN_SECONDS", "ABYSSAL_ROOM",
        "ABYSSAL_EXITED", "ABYSSAL_FAILED", "ABYSSAL_FAILED_PLAIN"]) {
        assert.ok(TRIGGER_TEXT[lang][k].length >= 2 && TRIGGER_TEXT[lang][k].every((l) => !/\d/.test(l)), `${lang} ${k}`);
      }
    }
  });
};
