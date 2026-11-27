"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { readSkillHistoryFrom, SKILL_DONE_EVENTS } = require("../../lib/adapter/shipAiDbRead");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { createShipAiEventsRepository } = require("../../lib/shipAi/events");
const { createProactive } = require("../../lib/shipAi/proactive");
const { createToolRunner } = require("../../lib/shipAi/tools/loop");
const { createShipAiWatch, disabledKindsOf } = require("../../lib/shipAi/watch");
const { skillEvents, missionEvents } = require("../../lib/shipAi/watch/sources");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const PLAYER = 9001;
const OTHER = 9002;
const JITA = 30000142;
const T0 = 1700000000000;
const MINUTE = 60000;
const HOUR = 3600000;
const GUNNERY = 3300;
const DRONES = 3436;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}
const fileTime = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const NOTIMER = () => ({ cancel() {}, hasRef: () => false });
const NAMES = { [GUNNERY]: "Gunnery", [DRONES]: "Drones" };

function watchRig(store, data, opts = {}) {
  const M = settings({ watchDisabledKinds: "JOB_READY,ORDER_FILLED,MISSION_OBJECTIVE", walletWatchEnabled: false,
    queueWatchEnabled: false, ...(opts.over || {}) });
  let now = opts.now || T0;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const online = new Set();
  const quiet = new Set();
  const reads = [];
  const offers = [];
  const toolDeps = {
    skillHistory: (playerId, sinceMs, max) => {
      reads.push(["skills", playerId, sinceMs]);
      return readSkillHistoryFrom({ characterState: { peekCharacterRecord: () => data.record } }, playerId,
        { sinceMs, max });
    },
    missionsRaw: (playerId) => {
      reads.push(["missions", playerId]);
      return { ok: true, missions: data.missions, more: 0 };
    },
    typeName: (t) => NAMES[t] || null,
    systemName: (id) => (id === JITA ? "Jita" : null),
  };
  const watch = createShipAiWatch({ S: M, store, eventsRepo: createShipAiEventsRepository(M), toolDeps,
    readPresence: () => ({ ok: true, characters: [...online].map((characterId) => ({ characterId, systemId: JITA })) }),
    isWatched: () => true, isAllowed: () => true, isQuiet: (id) => quiet.has(id),
    offer: (playerId, events) => {
      offers.push([playerId, events.map((e) => e.key)]);
      return { queued: events.length };
    },
    nowMs: clock.now, perfNow: () => 0, setTimer: NOTIMER });
  assert.deepStrictEqual(watch.start(), { ok: true, running: true });
  return { M, watch, clock, online, quiet, reads, offers };
}

function proactiveRig(opts = {}) {
  const M = settings(opts.over);
  let now = T0;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const specs = [];
  const replies = opts.replies || [];
  const raw = { request(spec) {
    specs.push(spec);
    const next = replies.shift();
    if (next === "pending") return new Promise(() => {});
    return Promise.resolve(next || { ok: true, text: "Noted, captain.", toolCalls: null, totalTokens: 10 });
  } };
  const runner = createToolRunner({ client: raw, S: M, deps: {}, nowMs: clock.now });
  const online = new Map(opts.online || [[PLAYER, { systemId: JITA, state: "space" }]]);
  const delivered = [];
  const mentioned = [];
  const toolDeps = {
    telemetry: () => ({ ok: true, docked: false, shipTypeId: 587, armorPermille: 1000, structurePermille: 1000 }),
    typeName: () => "Rifter", itemByName: () => ({ ok: true, found: false }), graph: () => null };
  const eventsRepo = { noteEventInTx: () => ({ ok: true, inserted: true }),
    markMentionedInTx: (_db, spec) => {
      mentioned.push(spec.key);
      return { ok: true, changed: 1 };
    },
    listPendingPods: () => ({ ok: true, playerIds: [] }) };
  const p = createProactive({ S: M, maxIdentities: 16, store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
    prefsRepo: { setLastProactive: () => ({ ok: true, changed: 1 }) }, eventsRepo,
    adapter: { readPresence: () => ({ ok: true, characters: [...online].map(([characterId, v]) => ({ characterId,
      name: `P${characterId}`, ...v })) }) }, seam: null, toolDeps, client: runner,
    deliver: (id, lines) => {
      for (const l of lines) delivered.push([id, l]);
      return { room: lines.length, system: 0, failed: 0 };
    },
    nameOf: () => "Jin", isWatched: (id) => online.has(id), isAllowed: () => true,
    staticIndex: () => new Map([[JITA, { name: "Jita", security: "highsec", region: "The Forge", regionId: 10000002 }]]),
    snapshot: () => ({ json: "{}", presence: null }),
    initialPrefs: new Map([...online.keys()].map((id) => [id, { quiet: false, lastProactiveAt: null }])),
    nowMs: clock.now, setTimer: NOTIMER });
  assert.deepStrictEqual(p.start(), { ok: true, running: true });
  return { M, p, clock, online, specs, delivered, mentioned };
}

const eventOf = (spec) => {
  const data = spec.messages.find((m) => m.role === "system" && m.content.startsWith("DATA "));
  return JSON.parse(data.content.slice("DATA ".length)).event;
};

module.exports = ({ test, skip }) => {
  const driver = SH.loadDriver();
  const names = {
    w1: "W1 migration 89 ship_ai_events_watch_kinds: the old LOSS_SHIP row and the index stay, SKILL_DONE goes in, an "
      + "unknown kind does not; the CHECK list of the DDL = EVENT_KINDS",
    w3: "W3 watch pass: no read before watchLoginDelayMs, then 1 skills + 1 missions read and only the inserted events "
      + "offered; restart = the not mentioned rows back to pending, the same data = 0 inserts (PK); quiet = 0 reads",
    w6: "W6: a told SKILL_DONE, then eventsKeep + 5 DOCK rows (the DOCK rows are pruned), then a "
      + "relog -> the skill row survives, 0 inserts, nothing offered again",
  };
  if (!driver.ok) {
    for (const n of [names.w1, names.w3, names.w6]) skip(n, `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test(names.w6, () => SH.withStore(driver, ({ store }) => {
      const data = { record: { skillHistory: [{ logDate: fileTime(T0 - 10 * MINUTE), eventTypeID: 37,
        skillTypeID: GUNNERY }] }, missions: [] };
      const r = watchRig(store, data);
      const repo = createShipAiEventsRepository(r.M);
      const tx = (fn) => {
        const res = store.transaction("t.w6", fn);
        assert.ok(res.ok && res.value && res.value.ok, JSON.stringify(res));
        return res.value;
      };
      const login = () => {
        r.online.add(PLAYER);
        r.watch.runPass();
        r.clock.advance(r.M.watchLoginDelayMs);
        r.watch.runPass();
      };
      login();
      const key = `skill:${GUNNERY}:${T0 - 10 * MINUTE}`;
      assert.deepStrictEqual(r.offers, [[PLAYER, [key]]]);
      tx((db) => repo.markMentionedInTx(db, { playerId: PLAYER, key, atMs: r.clock.now() }));
      for (let i = 0; i < r.M.eventsKeep + 5; i += 1) {
        r.clock.advance(MINUTE);
        tx((db) => repo.noteEventInTx(db, { playerId: PLAYER, kind: "DOCK", key: `dock:${JITA}:${i}`,
          payload: {}, nowMs: r.clock.now() }));
      }
      const rows = tx((db) => repo.listRecent(db, PLAYER, 500)).rows;
      assert.strictEqual(rows.filter((x) => x.kind === "DOCK").length, r.M.eventsKeep, "eventsKeep pruned DOCK rows");
      assert.ok(rows.some((x) => x.key === key), "the watch row survives the retention");
      r.online.delete(PLAYER);
      r.watch.runPass();
      login();
      const st = r.watch.getStatus().counters;
      assert.deepStrictEqual([st.events, st.duplicates, r.offers.length], [1, 1, 1], "0 inserts after the relog");
      r.watch.stop();
    }));

    test(names.w1, () => {
      const m = MIGRATIONS.find((x) => x.name === "ship_ai_events_watch_kinds");
      assert.ok(m && m.version === 89 && m.up === S.upShipAiEventsWatchKinds, "migration 89");
      const ddl = String(S.upShipAiEventsWatchKinds);
      const list = /kind\s+TEXT\s+NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(ddl);
      assert.ok(list, "the CHECK of kind in the DDL");
      assert.deepStrictEqual(list[1].split(",").map((s) => s.trim().replace(/'/g, "")), S.EVENT_KINDS.slice(0, 13));
      const db = new driver.Database(":memory:");
      try {
        S.upShipAiEvents(db);
        const insert = (key, kind) => db.prepare(`INSERT INTO ship_ai_events (player_character_id, event_key, kind,
          payload, occurred_at, mentioned_at) VALUES (?, ?, ?, '{}', ?, NULL)`).run(PLAYER, key, kind, T0);
        insert("loss:1", "LOSS_SHIP");
        assert.throws(() => insert("skill:1:1", "SKILL_DONE"), "the old CHECK refuses SKILL_DONE");
        db.exec("BEGIN");
        m.up(db);
        db.exec("COMMIT");
        const rows = db.prepare("SELECT event_key, kind, occurred_at FROM ship_ai_events").all();
        assert.deepStrictEqual(rows.map((r) => [r.event_key, r.kind, Number(r.occurred_at)]),
          [["loss:1", "LOSS_SHIP", T0]]);
        const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ship_ai_events' "
          + "AND name = 'ship_ai_events_recent'").all();
        assert.strictEqual(idx.length, 1, "the index ship_ai_events_recent");
        insert("skill:3300:1", "SKILL_DONE");
        insert("mission:7:1", "MISSION_EXPIRING");
        assert.throws(() => insert("x:1", "BOGUS"), "an unknown kind");
      } finally {
        db.close();
      }
    });

    test(names.w3, () => SH.withStore(driver, ({ store }) => {
      const data = { record: { skillHistory: [
        { logDate: fileTime(T0 - 10 * MINUTE), eventTypeID: 53, skillTypeID: GUNNERY },
        { logDate: fileTime(T0 - 20 * MINUTE), eventTypeID: 38, skillTypeID: DRONES },
        { logDate: fileTime(T0 - HOUR), eventTypeID: 37, skillTypeID: DRONES }] },
      missions: [{ title: "The Blockade", status: "accepted", done: false, systemId: JITA, agentId: 3008416,
        expiresAtMs: T0 + 20 * MINUTE }] };
      const r = watchRig(store, data);
      r.watch.runPass();
      r.online.add(PLAYER);
      r.watch.runPass();
      assert.strictEqual(r.watch.getStatus().queued, 2, "skills + missions scheduled");
      r.clock.advance(r.M.watchLoginDelayMs - 1);
      r.watch.runPass();
      assert.deepStrictEqual(r.reads, [], "no read before watchLoginDelayMs");
      r.clock.advance(1);
      r.watch.runPass();
      const now = T0 + r.M.watchLoginDelayMs;
      assert.deepStrictEqual(r.reads.map((x) => x.slice(0, 2)).sort(), [["missions", PLAYER], ["skills", PLAYER]]);
      assert.strictEqual(r.reads.find((x) => x[0] === "skills")[2], now - r.M.watchLookbackMs, "login = lookback");
      assert.strictEqual(r.offers.length, 1);
      assert.deepStrictEqual([r.offers[0][0], r.offers[0][1].slice().sort()], [PLAYER, [`mission:3008416:${T0 + 20 * MINUTE}`,
        `skill:${GUNNERY}:${T0 - 10 * MINUTE}`, `skill:${DRONES}:${T0 - HOUR}`]], "38 is no completed training");
      const st = r.watch.getStatus();
      assert.deepStrictEqual([st.counters.reads, st.counters.events, st.counters.duplicates], [2, 3, 0]);
      r.watch.stop();

      const again = watchRig(store, data, { now });
      again.online.add(PLAYER);
      again.watch.runPass();
      assert.strictEqual(again.offers.length, 1);
      assert.deepStrictEqual(again.offers[0][1].slice().sort(), r.offers[0][1].slice().sort(), "reload of pending");
      again.clock.advance(again.M.watchLoginDelayMs);
      again.watch.runPass();
      const st2 = again.watch.getStatus();
      assert.deepStrictEqual([st2.counters.reads, st2.counters.events, st2.counters.duplicates, again.offers.length],
        [2, 0, 3, 1], "the same data = 0 inserts (PK)");
      again.quiet.add(PLAYER);
      again.watch.setQuiet(PLAYER, true);
      assert.strictEqual(again.watch.getStatus().queued, 0);
      again.clock.advance(again.M.watchRescanMs);
      again.watch.runPass();
      assert.strictEqual(again.watch.getStatus().counters.reads, 2, "quiet = no read");
      assert.strictEqual(again.watch.getStatus().queued, 0);
      again.watch.stop();
    }));
  }

  test("W2 sources: skillEvents newer than the cursor, cursor = max; missionEvents accepted in the window only, "
    + "nextDueAt = the nearest end - warn", () => {
    const entries = [{ typeId: GUNNERY, atMs: T0 - MINUTE }, { typeId: DRONES, atMs: T0 - 2 * MINUTE },
      { typeId: 3301, atMs: T0 - HOUR }];
    const first = skillEvents(entries, null, (t) => NAMES[t] || null);
    assert.deepStrictEqual(first.events.map((e) => e.key), [`skill:3301:${T0 - HOUR}`, `skill:${DRONES}:${T0 - 2 * MINUTE}`,
      `skill:${GUNNERY}:${T0 - MINUTE}`]);
    assert.deepStrictEqual(first.events[2], { kind: "SKILL_DONE", key: `skill:${GUNNERY}:${T0 - MINUTE}`,
      payload: { skill: "Gunnery" }, occurredAt: T0 - MINUTE });
    assert.strictEqual(first.cursor, T0 - MINUTE);
    const next = skillEvents(entries, T0 - 2 * MINUTE, () => null);
    assert.deepStrictEqual([next.events.map((e) => e.key), next.cursor], [[`skill:${GUNNERY}:${T0 - MINUTE}`],
      T0 - MINUTE], "older than the cursor = none");
    assert.deepStrictEqual(skillEvents([], 5, () => null), { events: [], cursor: 5 });

    const warn = 30 * MINUTE;
    const mission = (agentId, over) => ({ title: `M${agentId}`, status: "accepted", done: false, systemId: JITA,
      agentId, expiresAtMs: T0 + 10 * MINUTE, ...over });
    const out = missionEvents([mission(1), mission(2, { status: "offered" }), mission(3, { done: true }),
      mission(4, { expiresAtMs: T0 + 2 * HOUR }), mission(5, { expiresAtMs: T0 + HOUR }), mission(6, { expiresAtMs: null }),
      mission(7, { expiresAtMs: T0 - MINUTE })], T0, warn, (id) => (id === JITA ? "Jita" : null));
    assert.deepStrictEqual(out.events, [{ kind: "MISSION_EXPIRING", key: `mission:1:${T0 + 10 * MINUTE}`,
      payload: { title: "M1", system: "Jita", minutesLeft: 10 }, occurredAt: T0, expiresAt: T0 + 10 * MINUTE }]);
    assert.strictEqual(out.nextDueAt, T0 + HOUR - warn, "the nearest end - warn (mission 5)");
    assert.strictEqual(missionEvents([mission(1)], T0, warn, () => null).nextDueAt, null);
  });

  test("W4 delivery: 3 pending -> one model request with the digest (MISSION first), every key mentioned; in flight "
    + "-> nothing and the pending stays; an expired mission is dropped before the plan", async () => {
    const events = [
      { kind: "SKILL_DONE", key: "skill:3300:1", payload: { skill: "Gunnery" }, occurredAt: T0 - 20 * MINUTE },
      { kind: "SKILL_DONE", key: "skill:3436:2", payload: { skill: "Drones" }, occurredAt: T0 - 10 * MINUTE },
      { kind: "MISSION_EXPIRING", key: "mission:7:9", payload: { title: "The Blockade", system: "Jita",
        minutesLeft: 25 }, occurredAt: T0, expiresAt: T0 + 25 * MINUTE }];
    const r = proactiveRig();
    r.p.runPass();
    assert.deepStrictEqual(r.p.offerWatchEvents(PLAYER, [...events, events[0]]), { queued: 3 }, "duplicate key ignored");
    r.clock.advance(1000);
    r.p.runPass();
    await flush();
    assert.strictEqual(r.specs.length, 1, "one request for the digest");
    const ev = eventOf(r.specs[0]);
    assert.deepStrictEqual(ev.events.map((e) => e.kind), ["MISSION_EXPIRING", "SKILL_DONE", "SKILL_DONE"]);
    assert.deepStrictEqual([ev.kind, ev.events[0].title, ev.events[0].minutesLeft, ev.events[1].skill,
      ev.events[1].minutesAgo], ["WATCH", "The Blockade", 24, "Gunnery", 20]);
    assert.ok(ev.hint.includes("missions") && ev.hint.includes("skill_queue"), JSON.stringify(ev.hint));
    assert.deepStrictEqual(r.mentioned.slice().sort(), ["mission:7:9", "skill:3300:1", "skill:3436:2"]);
    assert.deepStrictEqual(r.delivered, [[PLAYER, "Noted, captain."]]);
    const st = r.p.getStatus();
    assert.deepStrictEqual([st.watchPending, st.counters.watchLines, st.byKind.MISSION_EXPIRING], [0, 1, 1]);
    r.p.stop();

    const busy = proactiveRig({ replies: ["pending"], online: [[OTHER, { systemId: JITA, state: "space" }],
      [PLAYER, { systemId: JITA, state: "space" }]] });
    busy.p.runPass();
    busy.p.offerWatchEvents(PLAYER, events);
    busy.online.set(OTHER, { systemId: JITA, state: "docked" });
    busy.clock.advance(1000);
    busy.p.runPass();
    await flush();
    assert.strictEqual(busy.specs.length, 1, "only the DOCK request");
    assert.deepStrictEqual([busy.delivered.length, busy.p.getStatus().watchPending], [0, 3]);
    assert.ok(busy.mentioned.every((k) => k.startsWith("dock:")), "only the DOCK row of OTHER is mentioned");
    busy.p.stop();

    const late = proactiveRig();
    late.p.runPass();
    late.p.offerWatchEvents(PLAYER, [{ ...events[2], expiresAt: T0 + 500 }]);
    late.clock.advance(1000);
    late.p.runPass();
    await flush();
    assert.deepStrictEqual([late.specs.length, late.p.getStatus().counters.watchDropped, late.p.getStatus().watchPending],
      [0, 1, 0]);
    late.p.stop();
  });

  test("W5 vendor facts: 37/53, unshift + slice(0, 100), runtimeStatus accepted; readSkillHistoryFrom filters 37/53, "
    + "sinceMs and max; config defaults, unknown watchDisabledKinds", () => {
    const sq = fs.readFileSync(path.join(SERVER_SRC, "services", "skills", "training", "skillQueueRuntime.js"), "utf8");
    assert.ok(sq.includes("const SKILL_EVENT_TRAINING_COMPLETE = 37;"), "37");
    assert.ok(sq.includes("const SKILL_EVENT_QUEUE_TRAINING_COMPLETED = 53;"), "53");
    assert.ok(sq.includes("return [...newestFirst, ...previous].slice(0, 100);")
      && sq.includes("skillHistory: prependSkillHistory(record, [entry]),")
      && sq.includes("skillHistory: prependSkillHistory(record, history.reverse())")
      && /return \{\s*logDate: buildFiletimeString\(wholeSecond\),\s*eventTypeID:/.test(sq), "newest first, 100 kept");
    assert.deepStrictEqual([...SKILL_DONE_EVENTS], [37, 53]);
    const am = fs.readFileSync(path.join(SERVER_SRC, "services", "agent", "agentMissionRuntime.js"), "utf8");
    assert.ok(am.includes("runtimeStatus === \"accepted\""), "accepted");

    const rec = Object.freeze({ skillHistory: Object.freeze([
      { logDate: fileTime(T0 - MINUTE), eventTypeID: 37, skillTypeID: GUNNERY },
      { logDate: fileTime(T0 - 2 * MINUTE), eventTypeID: 38, skillTypeID: DRONES },
      { logDate: fileTime(T0 - 3 * MINUTE), eventTypeID: 53, skillTypeID: DRONES },
      { logDate: fileTime(T0 - 4 * MINUTE), eventTypeID: 53, skillTypeID: 3301 },
      { logDate: fileTime(T0 - HOUR), eventTypeID: 37, skillTypeID: 3302 }]) });
    const peeks = [];
    const mods = { characterState: { peekCharacterRecord: (id) => {
      peeks.push(id);
      return id === PLAYER ? rec : null;
    } } };
    assert.deepStrictEqual(readSkillHistoryFrom(mods, PLAYER, { sinceMs: T0 - 10 * MINUTE, max: 2 }), { ok: true,
      entries: [{ typeId: GUNNERY, atMs: T0 - MINUTE }, { typeId: DRONES, atMs: T0 - 3 * MINUTE }] });
    assert.deepStrictEqual(readSkillHistoryFrom(mods, PLAYER, { sinceMs: T0 - 10 * MINUTE, max: 8 }).entries
      .map((e) => e.typeId), [GUNNERY, DRONES, 3301], "38 out, older than sinceMs out");
    assert.deepStrictEqual(readSkillHistoryFrom(mods, OTHER, { sinceMs: 0, max: 8 }), { ok: false, reason: "NO_RECORD" });
    assert.deepStrictEqual(readSkillHistoryFrom({ characterState: null }, PLAYER, { sinceMs: 0, max: 8 }),
      { ok: false, reason: "SEAM_UNAVAILABLE" });
    assert.deepStrictEqual(peeks, [PLAYER, PLAYER, OTHER], "peekCharacterRecord only");

    const c = base.shipAi;
    assert.deepStrictEqual([c.watchEnabled, c.watchDisabledKinds, c.watchPollMs, c.watchReadsPerPass,
      c.watchPassBudgetMs, c.watchLoginDelayMs, c.watchLookbackMs, c.watchRescanMs, c.skillWatchMs, c.missionWarnMs,
      c.watchMaxPending, c.watchMaxPerLine, c.watchPendingMaxAgeMs],
    [true, "", 10000, 4, 20, 30000, 21600000, 900000, 120000, 1800000, 8, 4, 7200000]);
    const env = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1",
      EVEJS_LNE_SHIP_AI_WATCH_DISABLED_KINDS: "skill_done,FOO" } }).config.shipAi;
    const k = disabledKindsOf(env);
    assert.deepStrictEqual([[...k.disabled], k.unknown], [["SKILL_DONE"], ["FOO"]]);
    assert.ok(S.METRICS.includes(S.METRIC.watchReads) && S.METRICS.includes(S.METRIC.watchEvents));
  });
};
