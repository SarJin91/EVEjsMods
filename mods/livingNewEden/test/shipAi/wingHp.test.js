"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { STATIC } = require("../../lib/shipAi/data/persona");
const { createProactive, PRIORITY } = require("../../lib/shipAi/proactive");
const { bandOf, planWingHp, takeWingLine, buildWingHpLine, buildWingLossLine, wingDiagText } =
  require("../../lib/shipAi/wingHp");
const { parseAiCommand, ALERT_KINDS } = require("../../lib/shipAi/commands");
const { lossFactsOf } = require("../../lib/adapter/liveLossHook");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PLAYER = 9001;
const JITA = 30000142;
const T0 = 1700000000000;
const RIFTER = 587;
const FEROX = 16227;
const KESTREL = 602;
const ALGOS = 32872;
const MK = Object.freeze({ warnPct: 90, criticalPct: 50 });
const FULL = Object.freeze([1000, 1000, 1000]);

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;

function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const reading = (...copies) => ({ ok: true, copies: copies.map(([entityId, hp, name, typeId]) => ({ entityId,
  hp: hp.slice(), name: name === undefined ? "Ferox" : name, typeId: typeId || FEROX })) });

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function rig(opts = {}) {
  const M = settings({ language: "pl", ...(opts.over || {}) });
  let now = T0;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const online = new Map([[PLAYER, { systemId: JITA, state: opts.state || "space" }]]);
  const delivered = [];
  const logs = [];
  const notes = [];
  const wing = { calls: 0, copies: opts.copies || [], reply: null, loaded: opts.loaded !== false };
  const tele = { ok: true, docked: false, shipTypeId: RIFTER, armorPermille: 1000, structurePermille: 1000,
    ...(opts.tele || {}) };
  let listener = null;
  const toolDeps = {
    telemetry: () => ({ ...tele }),
    typeName: (t) => ({ [RIFTER]: "Rifter", [FEROX]: "Ferox", [KESTREL]: "Kestrel" }[t] || null),
    itemByName: () => ({ ok: true, found: false }),
    graph: () => null,
    wingLoaded: () => ({ ok: true, loaded: wing.loaded }),
    wingHpMarks: () => ({ ok: true, warnPct: 90, criticalPct: 50 }),
    wingCopies: (systemId, o) => {
      wing.calls += 1;
      assert.deepStrictEqual([systemId, o], [JITA, { scanMax: M.wingHpScanMax }]);
      return wing.reply || { ok: true, truncated: false, unreadable: 0,
        copies: wing.copies.map((c) => ({ ownerId: PLAYER, ...c, hp: c.hp.slice() })) };
    },
    ...(opts.deps || {}),
  };
  const eventsRepo = { noteEventInTx: (_db, spec) => {
    notes.push(spec.kind);
    return { ok: true, inserted: true };
  }, markMentionedInTx: () => ({ ok: true, changed: 1 }), listPendingPods: () => ({ ok: true, playerIds: [] }) };
  const adapter = {
    readPresence: () => ({ ok: true, characters: [...online].map(([characterId, v]) => ({ characterId,
      name: `P${characterId}`, ...v })) }),
    addLiveLossListener: (fn) => {
      listener = fn;
      return { ok: true, remove: () => { listener = null; } };
    },
  };
  const p = createProactive({ S: M, maxIdentities: 16, store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
    prefsRepo: { setLastProactive: () => ({ ok: true }) }, eventsRepo, adapter, seam: null, toolDeps,
    client: { request: () => Promise.resolve({ ok: false, reason: "DISABLED" }) },
    deliver: (id, lines) => {
      for (const l of lines) delivered.push(l);
      return { room: lines.length, system: 0, failed: 0 };
    },
    nameOf: () => "Jin", isWatched: (id) => id === PLAYER, isAllowed: () => true,
    staticIndex: () => new Map([[JITA, { name: "Jita", security: "highsec", region: "The Forge", regionId: 1 }]]),
    snapshot: () => ({ json: "{}", presence: null }),
    initialPrefs: new Map([[PLAYER, { quiet: false, lastProactiveAt: null }]]),
    nowMs: clock.now, setTimer: () => ({ cancel() {}, hasRef: () => false }), logger: { log: (l) => logs.push(l) } });
  assert.deepStrictEqual(p.start(), { ok: true, running: true });
  const pass = (ms) => {
    clock.advance(ms === undefined ? 5000 : ms);
    p.runPass();
  };
  return { M, p, clock, online, delivered, logs, notes, wing, tele, pass, loss: (facts) => listener(facts) };
}

module.exports = ({ test }) => {
  test("WH1 planner: 90/50 -> 1000->890 orange, 890->480 red, 1000->300 one red entry; first sight "
    + "400 silent; 480->520 no re-arm (< 53), 540 re-arms, 480 again only past wingHpLayerCooldownMs; null keeps", () => {
    const M = settings();
    assert.deepStrictEqual([bandOf(1000, MK), bandOf(900, MK), bandOf(899, MK), bandOf(500, MK), bandOf(499, MK),
      bandOf(0, MK)], [0, 0, 1, 1, 2, 2], "wing.py: pct = permille // 10, red first");
    let r = planWingHp(null, reading([1, FULL]), MK, T0, M);
    assert.deepStrictEqual([r.changes, r.state.copies.size, r.state.pending.size], [0, 1, 0], "first sight");
    r = planWingHp(r.state, reading([1, [890, 1000, 1000]]), MK, T0 + 5000, M);
    assert.strictEqual(r.changes, 1);
    assert.deepStrictEqual(r.state.pending.get("1:0"), { entityId: 1, name: "Ferox", layer: 0, band: 1, pct: 89,
      at: T0 + 5000 });
    r = planWingHp(r.state, reading([1, [480, 1000, 1000]]), MK, T0 + 10000, M);
    assert.deepStrictEqual([r.changes, r.state.pending.size, r.state.pending.get("1:0").band], [1, 1, 2],
      "orange -> red: the same key, the deepest colour");

    let w = planWingHp(null, reading([2, FULL]), MK, T0, M);
    w = planWingHp(w.state, reading([2, [300, 1000, 1000]]), MK, T0 + 5000, M);
    assert.deepStrictEqual([w.changes, [...w.state.pending.values()].map((p) => [p.band, p.pct])], [1, [[2, 30]]],
      "white -> red = one red entry");
    const first = planWingHp(null, reading([3, [400, 400, 400]]), MK, T0, M);
    assert.deepStrictEqual([first.changes, first.state.pending.size], [0, 0], "first sight at 400: silent");

    let s = planWingHp(planWingHp(null, reading([4, FULL]), MK, T0, M).state, reading([4, [480, 1000, 1000]]), MK,
      T0 + 1000, M).state;
    const told = takeWingLine(s, T0 + 1000, M);
    assert.strictEqual(told.entries.length, 1);
    s = told.state;
    const up1 = planWingHp(s, reading([4, [520, 1000, 1000]]), MK, T0 + 2000, M);
    assert.deepStrictEqual([up1.changes, up1.state.copies.get(4).armed[0]], [0, 2], "52% < 50 + 3: not re-armed");
    const up2 = planWingHp(up1.state, reading([4, [540, 1000, 1000]]), MK, T0 + 3000, M);
    assert.deepStrictEqual([up2.changes, up2.state.copies.get(4).armed[0]], [0, 1], "54% re-arms to orange, no entry");
    const down = planWingHp(up2.state, reading([4, [480, 1000, 1000]]), MK, T0 + 4000, M);
    assert.deepStrictEqual([down.changes, down.suppressed], [0, 1], "the same red within the layer cooldown");
    const up3 = planWingHp(down.state, reading([4, [540, 1000, 1000]]), MK, T0 + 5000, M);
    const late = planWingHp(up3.state, reading([4, [480, 1000, 1000]]), MK, T0 + 1000 + M.wingHpLayerCooldownMs, M);
    assert.strictEqual(late.changes, 1, "past wingHpLayerCooldownMs: an entry");

    const kept = planWingHp(up2.state, null, MK, T0 + 6000, M);
    assert.deepStrictEqual(kept.state.copies.get(4), up2.state.copies.get(4), "no reading: the state stays");
    assert.strictEqual(planWingHp(kept.state, { ok: true, copies: [] }, MK, T0 + 7000, M).state.copies.size, 0,
      "a copy missing from a good reading leaves");
  });

  test("WH2 fleet line: 3 copies change in one pass -> one line of 2 clauses + one more, the "
    + "pending cleared; minGap holds the next one; a colour back up drops its entry; Ferox 2; pl / en <= maxChars", () => {
    const M = settings({ wingHpMaxPerLine: 2 });
    let s = planWingHp(null, reading([10, FULL], [11, FULL], [12, FULL, "Kestrel", KESTREL]), MK, T0, M).state;
    assert.deepStrictEqual([...s.copies.values()].map((c) => c.name), ["Ferox", "Ferox 2", "Kestrel"]);
    const r = planWingHp(s, reading([10, [850, 300, 1000]], [11, [1000, 1000, 400]],
      [12, [800, 1000, 1000], "Kestrel", KESTREL]), MK, T0 + 5000, M);
    assert.strictEqual(r.changes, 4);
    const line = takeWingLine(r.state, T0 + 5000, M);
    assert.deepStrictEqual([line.entries.map((e) => e.name), line.more, line.state.pending.size],
      [["Ferox 2", "Ferox"], 1, 0], "worst colour, then the hull weight; the rest is never told later");
    const opts = { maxChars: M.wingHpMaxChars, maxNameChars: M.wingHpMaxNameChars };
    const pl = buildWingHpLine(line.entries, line.more, "pl", 0, opts);
    assert.strictEqual(pl, "Ferox 2: kadłub 40%; Ferox: osłony 85%, pancerz 30%. I jeszcze 1. Kadłub zaraz pójdzie!");
    const en = buildWingHpLine(line.entries, line.more, "en", 0, opts);
    assert.strictEqual(en, "Ferox 2: hull 40%; Ferox: shields 85%, armor 30%. Plus 1 more. Hull's about to go!");
    assert.ok(pl.length <= M.wingHpMaxChars && en.length <= M.wingHpMaxChars);
    const short = buildWingHpLine(line.entries, line.more, "pl", 0, { maxChars: 40, maxNameChars: 24 });
    assert.ok(short.length > 0 && short.length <= 40 && short.startsWith("Ferox 2: kadłub 40%"), short);
    assert.strictEqual(buildWingHpLine([line.entries[1]], 0, "pl", 1, opts),
      "Kapitanie, Ferox: osłony 85%, pancerz 30%. Pancerz na wykończeniu.", "one copy, the seed variant");
    assert.strictEqual(buildWingHpLine([], 0, "pl", 0, opts), "");

    s = line.state;
    const next = planWingHp(s, reading([10, [850, 300, 1000]], [11, [1000, 1000, 400]],
      [12, [400, 1000, 1000], "Kestrel", KESTREL]), MK, T0 + 6000, M);
    assert.strictEqual(next.changes, 1);
    assert.strictEqual(takeWingLine(next.state, T0 + 6000, M), null, "within wingHpMinGapMs: the entry waits");
    const back = planWingHp(next.state, reading([10, [850, 300, 1000]], [11, [1000, 1000, 400]],
      [12, [960, 1000, 1000], "Kestrel", KESTREL]), MK, T0 + 7000, M);
    assert.deepStrictEqual([back.state.pending.size, back.dropped], [0, 1], "back up past the re-arm: dropped");
    assert.strictEqual(takeWingLine(back.state, T0 + 5000 + M.wingHpMinGapMs, M), null, "nothing left to say");
  });

  test("WH3 loss: lossFactsOf on a destroying copy -> copy:true, copyName Ferox; the ship of the player -> "
    + "copy:false; createProactive: WING_LOSS line, no LOSS_SHIP row; the same itemID twice = one line",
  async () => {
    const copyEntity = { kind: "ship", transient: true, characterID: 0, pilotCharacterID: PLAYER, ownerID: PLAYER,
      itemID: 5001, typeID: FEROX, itemName: "Ferox", systemID: JITA, destroying: true,
      destructionState: "destroying", session: null };
    const facts = lossFactsOf(copyEntity, { success: true }, { killID: 88 });
    assert.deepStrictEqual([facts.victimCharacterId, facts.copy, facts.copyName], [PLAYER, true, "Ferox"]);
    const own = lossFactsOf({ kind: "ship", characterID: PLAYER, itemID: 6001, typeID: RIFTER,
      session: { characterID: PLAYER } }, { success: true }, { killID: 89 });
    assert.deepStrictEqual([own.copy, own.copyName], [false, null]);

    const r = rig({ copies: [{ entityId: 5001, typeId: FEROX, name: "Ferox", hp: [1000, 1000, 1000] }] });
    r.pass();
    r.pass();
    r.loss(facts);
    r.loss(facts);
    r.pass();
    await flush();
    assert.deepStrictEqual(r.delivered, ["Straciliśmy Ferox!"]);
    const st = r.p.getStatus();
    assert.deepStrictEqual([st.counters.wingLossLines, st.counters.wingLossDuplicate, st.counters.lossesNoted,
      st.byKind.WING_LOSS, st.byKind.LOSS_SHIP], [1, 1, 0, 1, 0]);
    assert.ok(!r.notes.includes("LOSS_SHIP"), "no LOSS_SHIP row for a copy");
    r.loss(facts);
    r.pass();
    assert.deepStrictEqual(r.delivered, ["Straciliśmy Ferox!"], "a told loss stays known");
    assert.strictEqual(buildWingLossLine(["Ferox", "Kestrel", "Merlin"], "pl", 0, {}),
      "Straciliśmy Ferox, Kestrel i Merlin.");
    assert.strictEqual(buildWingLossLine(["Ferox"], "en", 1, {}), "Ferox is gone, Captain.");
  });

  test("WH4 zero work and DRIFT: no ShipWing = no copy read and one log line; docked = no read; empty scene "
    + "= no state; a refused copy read keeps LOW_HP; LOW_HP wins a pass and the colour change follows later", () => {
    const off = rig({ loaded: false, copies: [{ entityId: 1, hp: [1000, 1000, 1000], name: "Ferox" }] });
    for (let i = 0; i < 3; i += 1) off.pass();
    assert.deepStrictEqual([off.wing.calls, off.p.getStatus().wing.live], [0, false]);
    assert.deepStrictEqual(off.logs.filter((l) => l.includes("wing off")), ["shipAi proactive: wing off - NOT_LOADED"]);
    const switchedOff = rig({ over: { wingHpEnabled: false } });
    for (let i = 0; i < 2; i += 1) switchedOff.pass();
    assert.strictEqual(switchedOff.wing.calls, 0, "wingHpEnabled false");

    const docked = rig({ state: "docked", copies: [{ entityId: 1, hp: [1000, 1000, 1000], name: "Ferox" }] });
    for (let i = 0; i < 3; i += 1) docked.pass();
    assert.strictEqual(docked.wing.calls, 0, "docked: no read");
    const empty = rig();
    for (let i = 0; i < 3; i += 1) empty.pass();
    assert.deepStrictEqual([empty.wing.calls, empty.p.getStatus().wing.players, empty.delivered], [2, 0, []]);

    const drift = rig();
    drift.wing.reply = { ok: false, reason: "SEAM_UNAVAILABLE" };
    drift.tele.armorPermille = 200;
    drift.pass();
    drift.pass();
    assert.deepStrictEqual(drift.delivered.filter((l) => STATIC.pl.LOW_HP.includes(l)).length, 1, "LOW_HP goes on");
    assert.ok(drift.p.getStatus().counters.wingSensorFailed >= 1);
    assert.deepStrictEqual(drift.logs.filter((l) => l.includes("wing copies")),
      ["shipAi proactive: wing copies refused - SEAM_UNAVAILABLE"]);

    const both = rig({ copies: [{ entityId: 7, hp: [1000, 1000, 1000], name: "Ferox" }] });
    both.pass();
    both.pass();
    both.wing.copies[0].hp = [850, 1000, 1000];
    both.tele.armorPermille = 200;
    both.pass();
    assert.deepStrictEqual(both.delivered.length, 1);
    assert.ok(STATIC.pl.LOW_HP.includes(both.delivered[0]), "LOW_HP (80) wins over WING_HP (77)");
    both.pass();
    assert.deepStrictEqual(both.delivered.slice(1), ["Kapitanie, Ferox: osłony 85%."], "the colour change follows");
    both.pass();
    assert.strictEqual(both.delivered.length, 2, "no reminder");
    assert.deepStrictEqual(both.p.getStatus().wing, { live: true, marks: { warnPct: 90, criticalPct: 50,
      source: "shipWing" }, players: 1 });
  });

  test("WH5: a bad fallback pair (critical >= warn) -> one config warning and the defaults 90 / 50, shipAi "
    + "settings stay valid (no INVALID_SETTINGS)", () => {
    const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1",
      EVEJS_LNE_SHIP_AI_WING_HP_WARN_PCT: "40", EVEJS_LNE_SHIP_AI_WING_HP_CRITICAL_PCT: "60" } });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.warnings.filter((w) => w.startsWith("shipAi.wingHpCriticalPct (60) is not below")).length, 1,
      JSON.stringify(r.warnings));
    assert.deepStrictEqual([r.config.shipAi.wingHpWarnPct, r.config.shipAi.wingHpCriticalPct], [90, 50]);
    assert.deepStrictEqual([base.shipAi.wingHpWarnPct, base.shipAi.wingHpCriticalPct],
      [S.WING_HP_DEFAULT_MARKS.warnPct, S.WING_HP_DEFAULT_MARKS.criticalPct], "the schema pair = the config defaults");
    const direct = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, wingHpWarnPct: 50, wingHpCriticalPct: 50 } });
    assert.strictEqual(direct.ok, true, JSON.stringify(direct));
    assert.deepStrictEqual([direct.settings.wingHpWarnPct, direct.settings.wingHpCriticalPct], [90, 50]);
  });

  test("WH6 relaunch carry: a white Algos leaves (warp), the new entity of the same ship with shields 62% -> "
    + "one entry shield band 1 and an Algos 62% shield line; old and new entity in one reading too; wingHpCarryMs 0 = silent",
  () => {
    const M = settings();
    const white = planWingHp(null, reading([1, FULL, "Algos", ALGOS]), MK, T0, M).state;
    const gone = planWingHp(white, { ok: true, copies: [] }, MK, T0 + 5000, M);
    assert.deepStrictEqual([gone.state.copies.size, gone.state.left.size], [0, 1], "the colours wait in left");
    const back = planWingHp(gone.state, reading([2, [620, 1000, 1000], "Algos", ALGOS]), MK, T0 + 10000, M);
    assert.deepStrictEqual([back.changes, back.carried, back.state.left.size], [1, 1, 0]);
    assert.deepStrictEqual(back.state.pending.get("2:0"), { entityId: 2, name: "Algos", layer: 0, band: 1, pct: 62,
      at: T0 + 10000 });
    const line = takeWingLine(back.state, T0 + 10000, M);
    const text = buildWingHpLine(line.entries, line.more, "pl", 0,
      { maxChars: M.wingHpMaxChars, maxNameChars: M.wingHpMaxNameChars });
    assert.ok(text.includes("Algos: osłony 62%"), text);
    const swap = planWingHp(white, reading([2, [620, 1000, 1000], "Algos", ALGOS]), MK, T0 + 5000, M);
    assert.deepStrictEqual([swap.changes, swap.carried], [1, 1], "the old entity gone and the new one in one pass");
    const off = settings({ wingHpCarryMs: 0 });
    const old = planWingHp(planWingHp(planWingHp(null, reading([1, FULL, "Algos", ALGOS]), MK, T0, off).state,
      { ok: true, copies: [] }, MK, T0 + 5000, off).state, reading([2, [620, 1000, 1000], "Algos", ALGOS]), MK,
    T0 + 10000, off);
    assert.deepStrictEqual([old.changes, old.carried, old.state.pending.size], [0, 0, 0], "carry 0: the old behaviour");

    const r = rig({ copies: [{ entityId: 1, typeId: ALGOS, name: "Algos", hp: [1000, 1000, 1000] }] });
    r.pass();
    r.pass();
    r.wing.copies = [];
    r.pass();
    assert.strictEqual(r.p.getStatus().wing.players, 1, "the state of the player stays (left)");
    r.wing.copies = [{ entityId: 2, typeId: ALGOS, name: "Algos", hp: [620, 1000, 1000] }];
    r.pass();
    assert.strictEqual(r.delivered.length, 1, JSON.stringify(r.delivered));
    assert.ok(r.delivered[0].includes("Algos: osłony 62%"), r.delivered[0]);
    assert.strictEqual(r.p.getStatus().counters.wingHpCarried, 1);
  });

  test("WH7 carry without a duplicate: an orange copy told, the relaunch still orange = no entry; a "
    + "relaunch past wingHpCarryMs = a silent first sight; two Ferox come back FIFO", () => {
    const M = settings();
    let s = planWingHp(planWingHp(null, reading([1, FULL]), MK, T0, M).state, reading([1, [850, 1000, 1000]]), MK,
      T0 + 5000, M).state;
    s = takeWingLine(s, T0 + 5000, M).state;
    s = planWingHp(s, { ok: true, copies: [] }, MK, T0 + 10000, M).state;
    const same = planWingHp(s, reading([2, [840, 1000, 1000]]), MK, T0 + 15000, M);
    assert.deepStrictEqual([same.changes, same.carried, same.state.pending.size], [0, 1, 0], "the same colour");
    const late = planWingHp(s, reading([2, [400, 1000, 1000]]), MK, T0 + 10001 + M.wingHpCarryMs, M);
    assert.deepStrictEqual([late.changes, late.carried, late.state.left.size], [0, 0, 0], "past wingHpCarryMs");

    let f = planWingHp(null, reading([10, FULL], [11, FULL]), MK, T0, M).state;
    f = planWingHp(f, reading([10, FULL], [11, [850, 1000, 1000]]), MK, T0 + 5000, M).state;
    f = takeWingLine(f, T0 + 5000, M).state;
    f = planWingHp(f, { ok: true, copies: [] }, MK, T0 + 10000, M).state;
    assert.strictEqual(f.left.get(`${FEROX}:Ferox`).length, 2);
    const fifo = planWingHp(f, reading([20, [850, 1000, 1000]], [21, [850, 1000, 1000]]), MK, T0 + 15000, M);
    assert.deepStrictEqual([[...fifo.state.pending.keys()], fifo.carried], [["20:0"], 2],
      "20 takes the white baseline of 10, 21 the orange one of 11");
  });

  test("WH8 priority and age: an attack callout and a colour change in one pass -> the wing line; a "
    + "change held by wingHpMinGapMs ages out after 30 s: wingHpAged + 1, wingHpDropped unchanged", () => {
    assert.ok(PRIORITY.WING_HP > PRIORITY.HOSTILE_ATTACK && PRIORITY.WING_HP < PRIORITY.WING_LOSS);
    const SHIP = 1000000001;
    const NPC_TYPE = 23000;
    const SERPENTIS = 500020;
    const npcs = [];
    const r = rig({ copies: [{ entityId: 7, typeId: FEROX, name: "Ferox", hp: [1000, 1000, 1000] }],
      tele: { warping: false, entityId: SHIP, position: { x: 0, y: 0, z: 0 } },
      deps: { gridNpcs: () => ({ ok: true, truncated: false, npcs: npcs.map((n) => ({ ...n })) }),
        pirates: () => new Set([SERPENTIS]), standing: () => null, factionName: () => "Serpentis",
        invaderFactions: () => new Set(), typeName: (t) => ({ [RIFTER]: "Rifter", [FEROX]: "Ferox",
          [NPC_TYPE]: "Serpentis Scout" }[t] || null),
        itemByName: (name) => ({ ok: true, found: true, item: { groupName: name === "Rifter" ? "Frigate"
          : "Asteroid Serpentis Frigate" } }) } });
    r.pass();
    r.pass();
    npcs.push({ entityId: 8001, typeId: NPC_TYPE, factionId: SERPENTIS, position: { x: 5000, y: 0, z: 0 },
      targetId: SHIP, inWarp: false });
    r.wing.copies[0].hp = [850, 1000, 1000];
    r.pass();
    assert.strictEqual(r.delivered.length, 1, JSON.stringify(r.delivered));
    assert.ok(r.delivered[0].includes("Ferox: osłony 85%"), r.delivered[0]);
    r.pass();
    assert.ok(r.delivered.length === 2 && r.delivered[1].startsWith("Atakuje"), JSON.stringify(r.delivered));

    const g = rig({ over: { wingHpMinGapMs: 120000 }, copies: [{ entityId: 7, typeId: FEROX, name: "Ferox",
      hp: [1000, 1000, 1000] }] });
    g.pass();
    g.pass();
    g.wing.copies[0].hp = [850, 1000, 1000];
    g.pass();
    assert.strictEqual(g.delivered.length, 1);
    g.wing.copies[0].hp = [400, 1000, 1000];
    g.pass();
    const at = g.p.getStatus().counters;
    for (let i = 0; i < 6; i += 1) g.pass();
    assert.deepStrictEqual([at.wingHpAged, at.wingHpDropped, g.p.getStatus().counters.wingHpAged], [0, 0, 0],
      "30 s old: still news");
    g.pass();
    const c = g.p.getStatus().counters;
    assert.deepStrictEqual([c.wingHpAged, c.wingHpDropped, g.delivered.length], [1, 0, 1], "aged after 30 s");
  });

  test("WH9 diagnosis:!ai wing lines; the wing stats line once per wingHpStatsLogMs, none "
    + "without new reads; two cut reads = one truncated log line", () => {
    assert.deepStrictEqual([parseAiCommand("!ai wing"), parseAiCommand("!ai WING status")],
      [{ kind: "wing" }, { kind: "wing" }]);
    assert.ok(ALERT_KINDS.includes("wing"), "the static delivery of !ai alerts");
    const r = rig({ over: { wingHpStatsLogMs: 20000 },
      copies: [{ entityId: 3, typeId: ALGOS, name: "Algos", hp: [1000, 1000, 1000] }] });
    r.pass();
    r.pass();
    r.wing.copies[0].hp = [620, 1000, 1000];
    r.pass();
    const lines = wingDiagText(r.p.wingDiagOf(PLAYER), null, r.M.wingHpMaxPerLine);
    assert.deepStrictEqual(lines.slice(0, 2), ["wing alerts on (marks 90/50 shipWing), muted: no",
      "Algos: S 62% A 100% H 100% (armed S orange)"]);
    assert.ok(lines[2].startsWith("reads 2, copies 2, lines 1, carried 0"), lines[2]);
    assert.strictEqual(r.p.wingDiagOf(PLAYER + 1), null);
    assert.deepStrictEqual(wingDiagText(null, { on: false, marks: null, muted: false }, 3),
      ["wing alerts off (marks not read yet), muted: no", "no copy of yours seen yet"]);

    const stats = () => r.logs.filter((l) => l.startsWith("shipAi proactive: wing stats "));
    r.pass();
    assert.strictEqual(stats().length, 0, "within wingHpStatsLogMs");
    r.pass();
    assert.deepStrictEqual(stats(), ["shipAi proactive: wing stats reads=4 failed=0 scanTruncated=0 capped=0 "
      + "copies=4 lines=1 "
      + "entries=1 carried=0 suppressed=0 dropped=0 aged=0 lost=0"]);
    r.online.set(PLAYER, { systemId: JITA, state: "docked" });
    for (let i = 0; i < 5; i += 1) r.pass();
    assert.strictEqual(stats().length, 1, "docked: no read, no line");

    const t = rig({ copies: [{ entityId: 3, typeId: ALGOS, name: "Algos", hp: [1000, 1000, 1000] }] });
    t.wing.reply = { ok: true, truncated: true, unreadable: 0, copies: [] };
    for (let i = 0; i < 3; i += 1) t.pass();
    assert.deepStrictEqual(t.logs.filter((l) => l.includes("truncated")),
      ["shipAi proactive: wing copies truncated - SCAN_MAX"]);
    assert.deepStrictEqual([t.p.getStatus().counters.wingScanTruncated, t.p.getStatus().counters.wingCopiesCapped,
      t.p.getStatus().counters.wingTruncated], [2, 0, undefined]);
    const cap = rig({ over: { wingHpCopiesMax: 1 }, copies: [{ entityId: 3, typeId: ALGOS, name: "Algos",
      hp: [1000, 1000, 1000] }, { entityId: 4, typeId: ALGOS, name: "Algos", hp: [1000, 1000, 1000] }] });
    for (let i = 0; i < 3; i += 1) cap.pass();
    const cc = cap.p.getStatus().counters;
    assert.deepStrictEqual([cc.wingScanTruncated, cc.wingCopiesCapped], [0, 2]);
    assert.ok(wingDiagText(cap.p.wingDiagOf(PLAYER), null, 3)[2].includes("scan truncated 0, copies capped 2"));
  });

  test("WH10 config: wingHpCarryMs 180000, wingHpStatsLogMs 300000, wingHpPendingMaxAgeMs "
    + "30000 in SCHEMA and the settings; 0 allowed; a non-integer is refused by schema.js", () => {
    const { SCHEMA } = require("../../config");
    const row = (k) => SCHEMA.find((x) => x.key === `shipAi.${k}`);
    assert.deepStrictEqual([["wingHpCarryMs", "EVEJS_LNE_SHIP_AI_WING_HP_CARRY_MS", 180000],
      ["wingHpStatsLogMs", "EVEJS_LNE_SHIP_AI_WING_HP_STATS_LOG_MS", 300000],
      ["wingHpPendingMaxAgeMs", "EVEJS_LNE_SHIP_AI_WING_HP_PENDING_MAX_AGE_MS", 30000]].map(([k]) => [k, row(k).env,
      base.shipAi[k]]), [["wingHpCarryMs", "EVEJS_LNE_SHIP_AI_WING_HP_CARRY_MS", 180000],
      ["wingHpStatsLogMs", "EVEJS_LNE_SHIP_AI_WING_HP_STATS_LOG_MS", 300000],
      ["wingHpPendingMaxAgeMs", "EVEJS_LNE_SHIP_AI_WING_HP_PENDING_MAX_AGE_MS", 30000]]);
    const M = settings();
    assert.deepStrictEqual([M.wingHpCarryMs, M.wingHpStatsLogMs, M.wingHpPendingMaxAgeMs], [180000, 300000, 30000]);
    const zero = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1",
      EVEJS_LNE_SHIP_AI_WING_HP_CARRY_MS: "0", EVEJS_LNE_SHIP_AI_WING_HP_STATS_LOG_MS: "0" } }).config.shipAi;
    assert.deepStrictEqual([settings({ ...zero }).wingHpCarryMs, settings({ ...zero }).wingHpStatsLogMs], [0, 0]);
    for (const k of ["wingHpCarryMs", "wingHpStatsLogMs"]) {
      assert.deepStrictEqual(S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, [k]: 1.5 } }),
        { ok: false, reason: "INVALID_SETTINGS", detail: k });
    }
  });

  test("WH11 pending carry: shields 62% told, armour 70% held by wingHpMinGapMs, warp, the relaunch with "
    + "armour 70% -> one line 'Algos: pancerz 70%'; the same relaunch past wingHpPendingMaxAgeMs -> aged 1, no line",
  () => {
    const M = settings();
    const gap = Math.floor(M.wingHpMinGapMs / 2);
    let s = planWingHp(null, reading([1, FULL, "Algos", ALGOS]), MK, T0, M).state;
    s = planWingHp(s, reading([1, [620, 1000, 1000], "Algos", ALGOS]), MK, T0 + 1000, M).state;
    s = takeWingLine(s, T0 + 1000, M).state;
    const held = planWingHp(s, reading([1, [600, 700, 1000], "Algos", ALGOS]), MK, T0 + 1000 + gap, M);
    assert.deepStrictEqual([held.changes, held.state.pending.size], [1, 1]);
    assert.strictEqual(takeWingLine(held.state, T0 + 1000 + gap, M), null, "held by wingHpMinGapMs");
    const landAt = T0 + 1000 + M.wingHpMinGapMs + 1;
    const back = planWingHp(held.state, reading([2, [600, 700, 1000], "Algos", ALGOS]), MK, landAt, M);
    assert.deepStrictEqual([back.carried, back.changes, back.aged, [...back.state.pending.keys()]], [1, 0, 0, ["2:1"]]);
    assert.strictEqual(back.state.pending.get("2:1").at, T0 + 1000 + gap, "the original at");
    const line = takeWingLine(back.state, landAt, M);
    assert.ok(line, "the carried change is told");
    const text = buildWingHpLine(line.entries, line.more, "pl", 0,
      { maxChars: M.wingHpMaxChars, maxNameChars: M.wingHpMaxNameChars });
    assert.ok(text.includes("Algos: pancerz 70%") && !text.includes("osłony"), text);
    const late = planWingHp(held.state, reading([2, [600, 700, 1000], "Algos", ALGOS]), MK,
      T0 + 1000 + gap + M.wingHpPendingMaxAgeMs + 1, M);
    assert.deepStrictEqual([late.carried, late.aged, late.dropped, late.state.pending.size], [1, 1, 0, 0]);
    const up = planWingHp(held.state, reading([2, [600, 1000, 1000], "Algos", ALGOS]), MK, landAt, M);
    assert.deepStrictEqual([up.carried, up.state.pending.size], [1, 0], "the colour back up: no carried entry");
  });

  test("WH12 LOW sweep: a red entry carried at 51% (< 50 + rearm) stays and is told, 54% drops it; a lost copy "
    + "(also with the loss line off, also after it left) leaves no baseline for a new hull; !ai wing in help / !mods",
  () => {
    const M = settings();
    let s = planWingHp(null, reading([1, FULL, "Algos", ALGOS]), MK, T0, M).state;
    s = planWingHp(s, reading([1, [620, 1000, 1000], "Algos", ALGOS]), MK, T0 + 1000, M).state;
    s = takeWingLine(s, T0 + 1000, M).state;
    const held = planWingHp(s, reading([1, [480, 1000, 1000], "Algos", ALGOS]), MK, T0 + 2000, M);
    assert.strictEqual(held.state.pending.get("1:0").band, 2, "red held by wingHpMinGapMs");
    const landAt = T0 + 1000 + M.wingHpMinGapMs + 1;
    const keep = planWingHp(held.state, reading([2, [510, 1000, 1000], "Algos", ALGOS]), MK, landAt, M);
    assert.deepStrictEqual([keep.carried, keep.state.pending.get("2:0") && keep.state.pending.get("2:0").band,
      keep.state.copies.get(2).armed[0]], [1, 2, 2], "51% < 50 + 3: the red entry stays, armed red");
    const told = takeWingLine(keep.state, landAt, M);
    assert.ok(told && told.entries.length === 1 && told.entries[0].layers[0].band === 2, JSON.stringify(told));
    const drop = planWingHp(held.state, reading([2, [540, 1000, 1000], "Algos", ALGOS]), MK, landAt, M);
    assert.deepStrictEqual([drop.carried, drop.state.pending.size, drop.state.copies.get(2).armed[0]], [1, 0, 1],
      "54% past the re-arm: no carried entry");

    const facts = lossFactsOf({ kind: "ship", transient: true, characterID: 0, pilotCharacterID: PLAYER,
      ownerID: PLAYER, itemID: 5001, typeID: FEROX, itemName: "Ferox", systemID: JITA, destroying: true,
      destructionState: "destroying", session: null }, { success: true }, { killID: 90 });
    const hpLines = (r) => r.delivered.filter((l) => l.includes("Ferox:"));
    for (const over of [{ wingLossLineEnabled: false }, {}]) {
      const r = rig({ over, copies: [{ entityId: 5001, typeId: FEROX, name: "Ferox", hp: [1000, 1000, 1000] }] });
      r.pass();
      r.pass();
      r.wing.copies[0].hp = [850, 1000, 1000];
      r.pass();
      assert.strictEqual(hpLines(r).length, 1, JSON.stringify(r.delivered));
      if (over.wingLossLineEnabled === undefined) {
        r.wing.copies = [];
        r.pass();
        assert.strictEqual(r.p.wingDiagOf(PLAYER).left, 1, "the copy left before its loss was noted");
      }
      r.loss(facts);
      const diag = r.p.wingDiagOf(PLAYER);
      assert.deepStrictEqual(diag && [diag.copies.length, diag.left, diag.pending], diag ? [0, 0, 0] : null,
        JSON.stringify(diag));
      r.wing.copies = [{ entityId: 5002, typeId: FEROX, name: "Ferox", hp: [400, 1000, 1000] }];
      for (let i = 0; i < 3; i += 1) r.pass();
      assert.deepStrictEqual([hpLines(r).length, r.p.getStatus().counters.wingHpCarried], [1, 0],
        `${JSON.stringify(over)}: the new hull is a silent first sight ${JSON.stringify(r.delivered)}`);
      assert.strictEqual(r.p.getStatus().counters.wingLossLines, over.wingLossLineEnabled === false ? 0 : 1,
        JSON.stringify(r.delivered));
    }

    for (const lang of ["pl", "en"]) assert.ok(STATIC[lang].HELP.join(" ").includes("!ai wing"), `${lang} HELP`);
    const { CATALOG } = require("../../lib/modsHelp/catalog");
    assert.ok(CATALOG.find((e) => e.registryName === "ai").details.includes("!ai wing"));
    const src = require("node:fs").readFileSync(path.join(MOD_DIR, "lib", "shipAi", "index.js"), "utf8");
    assert.ok(/!ai wing - the HP alerts of your ship wing copies/.test(src), "the Local !ai help names !ai wing");
  });

  test("WH13 restore pct (of the LOW sweep): a red 48% entry carried at 51% (held by the hysteresis) is told "
    + "as 48%; carried at 45% (still red) as 45%", () => {
    const M = settings();
    let s = planWingHp(null, reading([1, FULL, "Algos", ALGOS]), MK, T0, M).state;
    s = planWingHp(s, reading([1, [620, 1000, 1000], "Algos", ALGOS]), MK, T0 + 1000, M).state;
    s = takeWingLine(s, T0 + 1000, M).state;
    const held = planWingHp(s, reading([1, [480, 1000, 1000], "Algos", ALGOS]), MK, T0 + 2000, M);
    assert.strictEqual(held.state.pending.get("1:0").pct, 48);
    const landAt = T0 + 1000 + M.wingHpMinGapMs + 1;
    const text = (hp) => {
      const r = planWingHp(held.state, reading([2, hp, "Algos", ALGOS]), MK, landAt, M);
      const line = takeWingLine(r.state, landAt, M);
      assert.ok(line, JSON.stringify(hp));
      return [r.state.pending.get("2:0").pct, buildWingHpLine(line.entries, line.more, "pl", 0,
        { maxChars: M.wingHpMaxChars, maxNameChars: M.wingHpMaxNameChars })];
    };
    const [outPct, outText] = text([510, 1000, 1000]);
    assert.ok(outPct === 48 && outText.includes("48%") && !outText.includes("51%"), outText);
    const [inPct, inText] = text([450, 1000, 1000]);
    assert.ok(inPct === 45 && inText.includes("45%"), inText);
  });
};
