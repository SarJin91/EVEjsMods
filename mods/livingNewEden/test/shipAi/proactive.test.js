"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { STATIC } = require("../../lib/shipAi/data/persona");
const { createShipAiClient } = require("../../lib/shipAi/client");
const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
const { createShipAiEventsRepository } = require("../../lib/shipAi/events");
const { createProactive } = require("../../lib/shipAi/proactive");
const { startShipAi } = require("../../lib/shipAi");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PLAYER = 9001;
const QUIET = 9002;
const STRANGER = 9003;
const OFFLINE = 9004;
const AI = 91000001;
const KEY = "test-key-not-real-0123";
const JITA = 30000142;
const TAMA = 30002813;
const T0 = 1700000000000;
const RIFTER = 587;
const CAPSULE = 670;
const XMPP = { transport: "xmpp" };

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;

function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function read(store, fn) {
  const r = store.transaction("t.read", fn);
  assert.ok(r.ok && r.value && r.value.ok, JSON.stringify(r));
  return r.value;
}

function insertPrefs(store, playerId, aiId) {
  const r = store.transaction("t.prefs", (db) => createShipAiPrefsRepository().insert(db,
    { playerId, aiId, name: "Jin", nowMs: 1000 }));
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
}

const eventsOf = (store, M, id) => read(store, (db) => createShipAiEventsRepository(M).listRecent(db, id, 50)).rows;
const prefsOf = (store, id) => read(store, (db) => createShipAiPrefsRepository().getByPlayer(db, id)).row;

const STATIC_INDEX = new Map([[JITA, { name: "Jita", security: "highsec", region: "The Forge", regionId: 10000002 }],
  [TAMA, { name: "Tama", security: "lowsec", region: "The Citadel", regionId: 10000033 }]]);

function rig(store, opts = {}) {
  const M = settings(opts.over);
  let now = T0;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const transport = { calls: [], post(spec) {
    this.calls.push(spec);
    return Promise.resolve({ ok: false, reason: "NET_ERROR" });
  } };
  const client = createShipAiClient({ S: M, apiKey: opts.key || "", transport, nowMs: clock.now });
  const online = new Map(Object.entries(opts.online || { [PLAYER]: { systemId: JITA, state: "space" } })
    .map(([id, v]) => [Number(id), v]));
  const tele = new Map();
  const teleCalls = [];
  const delivered = [];
  let listener = null;
  const toolDeps = {
    telemetry: (id) => {
      teleCalls.push(id);
      return tele.get(id) || { ok: true, docked: false, shipTypeId: RIFTER, armorPermille: 1000,
        structurePermille: 1000 };
    },
    typeName: (t) => ({ [RIFTER]: "Rifter", [CAPSULE]: "Capsule" }[t] || null),
    itemByName: () => ({ ok: true, found: false }),
    graph: () => null,
  };
  const adapter = {
    readPresence: () => ({ ok: true, characters: [...online].map(([characterId, v]) => ({ characterId,
      name: `P${characterId}`, ...v })) }),
    addLiveLossListener: (fn) => {
      listener = fn;
      return { ok: true, remove: () => { listener = null; } };
    },
  };
  const initialPrefs = new Map((opts.prefs || [[PLAYER, false]]).map(([id, quiet]) => [id,
    { quiet, lastProactiveAt: null }]));
  const watched = new Set([...initialPrefs.keys()]);
  const p = createProactive({ S: M, maxIdentities: 16, store, prefsRepo: createShipAiPrefsRepository(),
    eventsRepo: createShipAiEventsRepository(M), adapter, seam: null, toolDeps, client,
    deliver: (id, lines) => {
      for (const l of lines) delivered.push([id, l]);
      return { room: lines.length, system: 0, failed: 0 };
    },
    nameOf: () => "Jin", isWatched: (id) => watched.has(id), isAllowed: () => true,
    staticIndex: () => STATIC_INDEX, snapshot: () => ({ json: "{}", presence: null }), initialPrefs,
    nowMs: clock.now, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
  assert.deepStrictEqual(p.start(), { ok: true, running: true });
  return { M, p, clock, transport, online, tele, teleCalls, delivered, loss: (facts) => listener(facts) };
}

const linesOf = (r, kind) => r.delivered.filter(([, l]) => STATIC.en[kind].includes(l));

module.exports = ({ test, skip }) => {
  const driver = SH.loadDriver();
  const names = {
    p1: "P1 LOW_HP: armor below lowHpPermille in space -> the static line at once, zero HTTP requests; again only "
      + "after lowHpCooldownMs; docked = no warning; one LOW_HP event row per warning; migration 87, reset KEEP",
    p2: "P2 !ai quiet -> ship_ai_prefs.quiet 1 (kept across a restart), the pass reads nothing for him; !ai talk -> 0 "
      + "and the pass reads him again; !ai forget all confirm deletes his ship_ai_events rows",
    p3: "P3 the same loss delivered twice -> one ship_ai_events row (loss:<killId>), one LOSS_SHIP line",
    p4: "P4 pod loss -> at the next pass the clone line exactly once, the row mentioned; an unmentioned LOSS_POD row "
      + "at a restart -> the line on the second pass, once",
    p5: "P5 the pass reads the telemetry of the watched players only (prefs row, online, not quiet); the first pass "
      + "speaks no line; DOCK -> the model lane (no key -> the static fallback), last_proactive_at kept",
    p6: "P6: a ship loss during quiet -> a row, no late LOSS_SHIP line after talk: quiet while the "
      + "model request flies -> no line (droppedQuiet)",
  };
  if (!driver.ok) {
    for (const n of Object.values(names)) skip(n, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test(names.p1, () => SH.withStoreAsync(driver, async ({ store }) => {
    const { MIGRATIONS } = require("../../lib/persistence/migrations");
    const { TABLE_POLICY } = require("../../lib/persistence/worldReset");
    const m = MIGRATIONS.find((x) => x.name === "ship_ai_events");
    assert.ok(m && m.version >= 87, "migration ship_ai_events");
    assert.strictEqual(TABLE_POLICY.ship_ai_events, "KEEP");
    insertPrefs(store, PLAYER, AI);
    const r = rig(store, { key: KEY });
    r.tele.set(PLAYER, { ok: true, docked: false, shipTypeId: RIFTER, armorPermille: 200, structurePermille: 1000 });
    r.p.runPass();
    assert.strictEqual(r.delivered.length, 0, "first pass: state only");
    r.clock.advance(5000);
    r.p.runPass();
    assert.strictEqual(linesOf(r, "LOW_HP").length, 1);
    r.clock.advance(30000);
    r.p.runPass();
    assert.strictEqual(linesOf(r, "LOW_HP").length, 1, "inside lowHpCooldownMs");
    r.clock.advance(r.M.lowHpCooldownMs);
    r.p.runPass();
    assert.strictEqual(linesOf(r, "LOW_HP").length, 2, "past lowHpCooldownMs");
    await flush();
    assert.strictEqual(r.transport.calls.length, 0, "a warning never asks the model");
    r.online.set(PLAYER, { systemId: JITA, state: "docked" });
    r.tele.set(PLAYER, { ok: true, docked: true, shipTypeId: RIFTER, armorPermille: 200, structurePermille: 200 });
    r.clock.advance(r.M.lowHpCooldownMs);
    r.p.runPass();
    await flush();
    assert.strictEqual(linesOf(r, "LOW_HP").length, 2, "docked: no warning");
    assert.strictEqual(eventsOf(store, r.M, PLAYER).filter((e) => e.kind === "LOW_HP").length, 2,
      "one LOW_HP row per warning");
    r.p.stop();
  }));

  test(names.p2, () => SH.withStoreAsync(driver, async (opened) => {
    const { store } = opened;
    insertPrefs(store, PLAYER, AI);
    const timers = [];
    const teleCalls = [];
    const adapter = { shipAiSeams: () => ({ ok: true, seam: { identities: {
      corporationExists: () => ({ ok: true, exists: true }), writeCharacter: () => ({ ok: true }),
      flush: () => ({ ok: true }) }, xmpp: {}, channel: () => null,
    sensors: { telemetry: (id) => {
      teleCalls.push(id);
      return { ok: true, docked: true, shipTypeId: RIFTER, armorPermille: 1000, structurePermille: 1000 };
    } } } }),
    installChatCommand: () => ({ ok: true }), uninstallChatCommand: () => ({ ok: true }),
    readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER, name: "Pilot One", systemId: JITA,
      state: "docked" }] }),
    sendCharacterSystemLine: () => ({ ok: true }), readStaticMap: () => ({ ok: false, reason: "TEST" }) };
    const config = { ...base, shipAi: { ...base.shipAi, channel: "local", allowCharacterIds: "*", minIntervalMs: 0,
      toolMode: "off", autostartEnabled: false } };
    const start = () => {
      const s = startShipAi({ config, persistence: opened, adapter, clock: { now: () => T0 },
        setTimer: (fn, ms) => {
          timers.push({ fn, ms });
          return { cancel() {}, hasRef: () => false };
        } });
      assert.strictEqual(s.ok, true, JSON.stringify(s));
      return s.shipAi;
    };
    const firePass = () => [...timers].reverse().find((t) => t.ms === base.shipAi.proactivePollMs).fn();
    const say = (ai, text) => ai.handle({ characterId: PLAYER, systemId: JITA }, text, XMPP);
    let ai = start();
    firePass();
    assert.deepStrictEqual(teleCalls, [PLAYER], "talking: the pass reads him");
    assert.strictEqual(say(ai, "!ai quiet"), "Jin: I will keep quiet until you type !ai talk, captain");
    assert.strictEqual(prefsOf(store, PLAYER).quiet, true);
    firePass();
    assert.deepStrictEqual(teleCalls, [PLAYER], "quiet: no read, no line");
    ai.stop("test");
    ai = start();
    assert.strictEqual(ai.getStatus().proactive.quiet, 1, "quiet survives a restart");
    firePass();
    assert.deepStrictEqual(teleCalls, [PLAYER]);
    assert.match(say(ai, "!ai talk"), /^Jin: I am back, captain/);
    assert.strictEqual(prefsOf(store, PLAYER).quiet, false);
    firePass();
    assert.deepStrictEqual(teleCalls, [PLAYER, PLAYER]);
    const M = settings();
    const w = store.transaction("t.event", (db) => createShipAiEventsRepository(M).noteEventInTx(db,
      { playerId: PLAYER, kind: "DOCK", key: "dock:1:1", payload: { system: "Jita" }, nowMs: T0 }));
    assert.ok(w.ok && w.value.inserted, JSON.stringify(w));
    say(ai, "!ai forget all");
    assert.strictEqual(say(ai, "!ai forget all confirm"), "Jin: done, I remember nothing about you now");
    assert.strictEqual(eventsOf(store, M, PLAYER).length, 0);
    ai.stop("test");
  }));

  test(names.p3, () => SH.withStoreAsync(driver, async ({ store }) => {
    insertPrefs(store, PLAYER, AI);
    const r = rig(store);
    r.p.runPass();
    const loss = { victimCharacterId: PLAYER, shipTypeId: RIFTER, itemId: 5001, killId: 77, systemId: JITA };
    r.loss(loss);
    r.loss({ ...loss });
    r.loss({ ...loss, victimCharacterId: STRANGER });
    r.clock.advance(5000);
    r.p.runPass();
    await flush();
    const rows = eventsOf(store, r.M, PLAYER);
    assert.deepStrictEqual(rows.map((e) => [e.key, e.kind, e.payload.ship, e.payload.system]),
      [["loss:77", "LOSS_SHIP", "Rifter", "Jita"]]);
    assert.strictEqual(r.p.getStatus().counters.lossesDuplicate, 1);
    assert.strictEqual(eventsOf(store, r.M, STRANGER).length, 0, "no prefs row = not watched");
    r.loss(loss);
    r.clock.advance(5000);
    r.p.runPass();
    await flush();
    assert.strictEqual(linesOf(r, "LOSS_SHIP").length, 1, "one line for the loss");
    assert.strictEqual(eventsOf(store, r.M, PLAYER).length, 1);
    r.p.stop();
  }));

  test(names.p4, () => SH.withStoreAsync(driver, async ({ store }) => {
    insertPrefs(store, PLAYER, AI);
    const r = rig(store);
    r.p.runPass();
    r.loss({ victimCharacterId: PLAYER, shipTypeId: CAPSULE, itemId: 6001, killId: 78, systemId: JITA });
    r.online.set(PLAYER, { systemId: JITA, state: "docked" });
    r.tele.set(PLAYER, { ok: true, docked: true, shipTypeId: CAPSULE, armorPermille: 1000, structurePermille: 1000 });
    for (let i = 0; i < 3; i += 1) {
      r.clock.advance(5000);
      r.p.runPass();
      await flush();
    }
    assert.strictEqual(linesOf(r, "LOSS_POD").length, 1, "the clone line exactly once");
    const pod = eventsOf(store, r.M, PLAYER).find((e) => e.kind === "LOSS_POD");
    assert.ok(pod && pod.mentionedAt !== null, JSON.stringify(pod));
    r.p.stop();

    const w = store.transaction("t.pod", (db) => createShipAiEventsRepository(r.M).noteEventInTx(db,
      { playerId: PLAYER, kind: "LOSS_POD", key: "loss:79", payload: {}, nowMs: T0 }));
    assert.ok(w.ok && w.value.inserted);
    const again = rig(store);
    again.p.runPass();
    assert.strictEqual(again.delivered.length, 0, "first pass after the boot: no line");
    for (let i = 0; i < 2; i += 1) {
      again.clock.advance(5000);
      again.p.runPass();
      await flush();
    }
    assert.strictEqual(linesOf(again, "LOSS_POD").length, 1);
    again.p.stop();
  }));

  test(names.p5, () => SH.withStoreAsync(driver, async ({ store }) => {
    for (const [id, ai] of [[PLAYER, AI], [QUIET, AI + 1], [OFFLINE, AI + 2]]) insertPrefs(store, id, ai);
    const r = rig(store, { over: { dangerBriefEnabled: false },
      online: { [PLAYER]: { systemId: JITA, state: "space" }, [QUIET]: { systemId: JITA, state: "space" },
        [STRANGER]: { systemId: JITA, state: "space" } },
      prefs: [[PLAYER, false], [QUIET, true], [OFFLINE, false]] });
    r.p.runPass();
    assert.deepStrictEqual(r.teleCalls, [PLAYER], "one telemetry read = one watched player");
    r.online.set(PLAYER, { systemId: TAMA, state: "space" });
    r.clock.advance(5000);
    r.p.runPass();
    assert.deepStrictEqual(r.teleCalls, [PLAYER, PLAYER]);
    assert.strictEqual(linesOf(r, "SYSTEM_DANGER").length, 1);
    r.online.set(PLAYER, { systemId: TAMA, state: "docked" });
    r.clock.advance(5000);
    r.p.runPass();
    await flush();
    assert.strictEqual(linesOf(r, "DOCK").length, 1);
    assert.strictEqual(prefsOf(store, PLAYER).lastProactiveAt, T0 + 10000);
    assert.strictEqual(r.p.getStatus().counters.limitRefunded, 0);
    assert.deepStrictEqual(eventsOf(store, r.M, PLAYER).map((e) => e.kind).sort(),
      ["DOCK", "REGION_ENTER", "SYSTEM_DANGER"]);
    const st = r.p.getStatus();
    assert.deepStrictEqual([st.counters.fallbacks, st.byKind.DOCK, st.byKind.SYSTEM_DANGER], [1, 1, 1]);
    r.online.set(PLAYER, { systemId: TAMA, state: "space" });
    r.clock.advance(r.M.proactiveKindCooldownMs);
    r.p.runPass();
    await flush();
    assert.strictEqual(linesOf(r, "UNDOCK").length, 0, "the global limit holds after a static fallback");
    r.p.stop();
  }));

  test(names.p6, () => SH.withStoreAsync(driver, async ({ store }) => {
    insertPrefs(store, PLAYER, AI);
    const r = rig(store);
    r.p.runPass();
    r.p.setQuiet(PLAYER, true);
    r.loss({ victimCharacterId: PLAYER, shipTypeId: RIFTER, itemId: 5101, killId: 81, systemId: JITA });
    r.clock.advance(5000);
    r.p.runPass();
    assert.strictEqual(eventsOf(store, r.M, PLAYER).filter((e) => e.kind === "LOSS_SHIP").length, 1, "row kept");
    r.p.setQuiet(PLAYER, false);
    for (let i = 0; i < 3; i += 1) {
      r.clock.advance(5000);
      r.p.runPass();
      await flush();
    }
    assert.strictEqual(linesOf(r, "LOSS_SHIP").length, 0, "no late loss line");
    r.p.stop();
    const q = rig(store, { key: KEY });
    q.p.runPass();
    q.online.set(PLAYER, { systemId: JITA, state: "docked" });
    q.clock.advance(5000);
    q.p.runPass();
    assert.strictEqual(q.p.getStatus().counters.modelRequests, 1);
    q.p.setQuiet(PLAYER, true);
    await flush();
    assert.strictEqual(q.delivered.length, 0, "no line after quiet");
    assert.strictEqual(q.p.getStatus().counters.droppedQuiet, 1);
    q.p.stop();
  }));
};
