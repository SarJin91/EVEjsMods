"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { TRIGGER_TEXT } = require("../../lib/shipAi/data/triggers");
const { readWalletIncomeFrom } = require("../../lib/adapter/shipAiDbRead");
const { createShipAiEventsRepository } = require("../../lib/shipAi/events");
const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
const { createProactive } = require("../../lib/shipAi/proactive");
const { createShipAiWatch } = require("../../lib/shipAi/watch");
const { walletEvents, queueEvents, missionEvents } = require("../../lib/shipAi/watch/sources");
const { watchTemplateOf, watchValuesOf, welcomeDecision, noteActivity, activityEntryOf, emptyTriggerState,
  parseNameList } = require("../../lib/shipAi/triggers");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const PLAYER = 9001;
const OTHER = 9002;
const AI = 91000001;
const JITA = 30000142;
const AMARR = 30002187;
const AGENT = 3008416;
const T0 = 1700000000000;
const MINUTE = 60000;
const HOUR = 3600000;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}
const fileTime = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);
const NOTIMER = () => ({ cancel() {}, hasRef: () => false });
const WS = { bountyMinIsk: 1000000, iskInMinIsk: 5000000, walletCursorSlackMs: 120000 };
const income = (transactionId, source, amountIsk, atMs, own = true) => ({ transactionId, source, amountIsk, atMs,
  own });
const mission = (over) => ({ title: "Gone Berserk", status: "accepted", done: false, systemId: JITA, agentId: AGENT,
  expiresAtMs: T0 + 24 * HOUR, ...(over || {}) });

function watchRig(store, data) {
  const M = settings({ watchDisabledKinds: "SKILL_DONE,JOB_READY,ORDER_FILLED,MISSION_EXPIRING" });
  let now = T0;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const where = new Map();
  const reads = [];
  const offers = [];
  const toolDeps = {
    missionsRaw: () => {
      reads.push("missions");
      return { ok: true, missions: data.missions, more: 0 };
    },
    walletIncome: () => {
      reads.push("wallet");
      return { ok: true, entries: data.wallet };
    },
    skillQueueRaw: () => {
      reads.push("queue");
      if (data.queueRefused === true) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      return { ok: true, active: data.queue.length > 0, queue: data.queue.slice(0, 1),
        more: Math.max(0, data.queue.length - 1) };
    },
    typeName: () => null,
    systemName: (id) => (id === JITA ? "Jita" : null),
  };
  const watch = createShipAiWatch({ S: M, store, eventsRepo: createShipAiEventsRepository(M), toolDeps,
    readPresence: () => ({ ok: true, characters: [...where].map(([characterId, systemId]) => ({ characterId,
      systemId })) }),
    isWatched: () => true, isAllowed: () => true, isQuiet: () => false,
    offer: (playerId, events) => {
      offers.push(...events.map((e) => e.key));
      return { queued: events.length };
    },
    nowMs: clock.now, perfNow: () => 0, setTimer: NOTIMER });
  assert.deepStrictEqual(watch.start(), { ok: true, running: true });
  return { M, watch, clock, where, reads, offers };
}

function welcomeRig(store, over, opts) {
  const o = opts || {};
  const M = settings({ language: "pl", calloutEnabled: false, triggersEnabled: false, ...(over || {}) });
  const repo = createShipAiPrefsRepository();
  const eventsRepo = createShipAiEventsRepository(M);
  const row = store.transaction("t.watch.row", (db) => repo.getByPlayer(db, PLAYER));
  assert.ok(row.ok && row.value.ok && row.value.row, JSON.stringify(row));
  const r = row.value.row;
  let now = o.now;
  const online = new Set([PLAYER]);
  const delivered = [];
  const requests = [];
  const toolDeps = { telemetry: () => ({ ok: true, docked: false, shipTypeId: 587, armorPermille: 1000,
    structurePermille: 1000, capacitorPermille: 900, warping: false }), typeName: () => "Rifter",
  itemByName: () => ({ ok: true, found: false }), graph: () => null };
  const p = createProactive({ S: M, maxIdentities: 4, store, prefsRepo: repo, eventsRepo,
    adapter: { readPresence: () => ({ ok: true, characters: [...online].map((characterId) => ({ characterId,
      name: "P", systemId: JITA, state: "space" })) }) }, seam: null, toolDeps,
    client: { request: (spec) => {
      requests.push(spec);
      return Promise.resolve({ ok: true, text: "Witaj z powrotem, kapitanie. Szkolenie gotowe." });
    } },
    deliver: (_id, lines) => {
      delivered.push(...lines);
      return { room: lines.length, system: 0, failed: 0 };
    }, nameOf: () => "Jin", isWatched: (id) => id === PLAYER, isAllowed: () => true,
    staticIndex: () => new Map([[JITA, { name: "Jita", security: "highsec", region: "The Forge", regionId: 1 }]]),
    snapshot: () => ({ json: "{}", presence: null }),
    initialPrefs: new Map([[PLAYER, { quiet: o.quiet === true, lastProactiveAt: o.lastProactiveAt ?? null,
      calloutMode: "on", dscanMode: "on", mutedKinds: [], lastSeenAt: r.lastSeenAt }]]),
    nowMs: () => now, setTimer: NOTIMER, logger: { log() {} } });
  p.start();
  const pass = (ms) => {
    now += ms;
    p.runPass();
  };
  const lastSeen = () => {
    const v = store.transaction("t.watch.seen", (db) => repo.getByPlayer(db, PLAYER));
    return v.value.row.lastSeenAt;
  };
  return { M, p, pass, online, delivered, requests, lastSeen, now: () => now };
}

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

module.exports = ({ test, skip }) => {
  test("TC1 walletEvents: baseline, bounty min, foreign, dedup, late entry in the slack, cursor never back, 33+34 one "
    + "ISK_IN; watchTemplateOf / watchValuesOf", () => {
    const old = [income(11, "bounty", 9e6, T0 - HOUR)];
    const first = walletEvents(old, null, T0, WS);
    assert.deepStrictEqual([first.events, first.cursor], [[], { atMs: T0 - HOUR, ids: [11] }], "baseline");
    const empty = walletEvents([], null, T0, WS);
    assert.deepStrictEqual(empty.cursor, { atMs: 0, ids: [] }, "an empty journal: every later entry is new");

    const r1 = walletEvents([income(12, "bounty", 1.5e6, T0), ...old], first.cursor, T0 + 1000, WS);
    assert.deepStrictEqual(r1.events, [{ kind: "BOUNTY_PAID", key: "bounty:12", payload: { isk: 1500000, payouts: 1 },
      occurredAt: T0 }]);
    const r2 = walletEvents([income(13, "bounty", 0.5e6, T0 + MINUTE), income(14, "donation", 9e6, T0 + MINUTE, false),
      income(12, "bounty", 1.5e6, T0), ...old], r1.cursor, T0 + MINUTE, WS);
    assert.deepStrictEqual([r2.events, r2.belowMin, r2.foreign], [[], 1, 1], "below min, foreign, 12 seen");

    const late = [income(15, "insurance", 7e6, T0 + MINUTE), income(16, "insurance", 1e6, T0 + 30000),
      income(13, "bounty", 0.5e6, T0 + MINUTE), income(12, "bounty", 1.5e6, T0)];
    const r3 = walletEvents(late, r2.cursor, T0 + 2 * MINUTE, WS);
    assert.deepStrictEqual(r3.events, [{ kind: "ISK_IN", key: "isk:insurance:16", payload: { source: "insurance",
      isk: 8000000 }, occurredAt: T0 + MINUTE }]);
    assert.deepStrictEqual(walletEvents(late, r3.cursor, T0 + 3 * MINUTE, WS).events, [], "the same entries again");
    const back = walletEvents([income(17, "bounty", 2e6, T0 - 10 * MINUTE)], r3.cursor, T0 + 3 * MINUTE, WS);
    assert.deepStrictEqual([back.events, back.cursor.atMs], [[], T0 + MINUTE], "older than the slack; never back");

    const mis = walletEvents([income(21, "mission", 4e6, T0 + 2 * MINUTE), income(22, "mission", 2e6,
      T0 + 2 * MINUTE)], r3.cursor, T0 + 2 * MINUTE, WS);
    assert.deepStrictEqual(mis.events, [{ kind: "ISK_IN", key: "isk:mission:22", payload: { source: "mission",
      isk: 6000000 }, occurredAt: T0 + 2 * MINUTE }]);

    assert.deepStrictEqual([watchTemplateOf(mis.events[0]), watchTemplateOf(r1.events[0]),
      watchTemplateOf({ kind: "ISK_IN", payload: { source: "donation" } }), watchTemplateOf({ kind: "SKILL_DONE" })],
    ["ISK_IN_MISSION", "BOUNTY_PAID", "ISK_IN_DONATION", "SKILL_DONE"]);
    assert.deepStrictEqual([watchValuesOf(r1.events[0], "pl"), watchValuesOf({ kind: "SKILL_DONE" }, "pl")],
      [{ isk: "1,5 mln ISK" }, {}]);
    for (const lang of ["pl", "en"]) {
      for (const k of ["BOUNTY_PAID", "ISK_IN_INSURANCE", "ISK_IN_MISSION", "ISK_IN_DONATION", "SKILL_QUEUE_EMPTY",
        "MISSION_OBJECTIVE", "WELCOME_BACK"]) assert.ok(TRIGGER_TEXT[lang][k].length >= 2, `${lang} ${k}`);
    }
  });

  test("TC2 queueEvents: login + empty = 1 (day key), not empty -> empty = 1, empty -> empty = 0, refused = null",
    () => {
    const empty = { ok: true, active: false, queue: [], more: 0 };
    const full = { ok: true, active: false, queue: [{ typeId: 3300, toLevel: 2 }], more: 3 };
    const login = queueEvents(null, empty, T0, true);
    assert.deepStrictEqual(login, { events: [{ kind: "SKILL_QUEUE_EMPTY",
      key: `queue:empty:login:${Math.floor(T0 / 86400000)}`, payload: { login: 1 }, occurredAt: T0 }], empty: true });
    assert.deepStrictEqual(queueEvents(null, full, T0, true), { events: [], empty: false }, "paused with entries");
    const went = queueEvents(false, empty, T0 + MINUTE, false);
    assert.deepStrictEqual([went.events.map((e) => e.key), went.empty],
      [[`queue:empty:${Math.floor((T0 + MINUTE) / MINUTE)}`], true]);
    assert.deepStrictEqual(queueEvents(true, empty, T0 + 2 * MINUTE, false), { events: [], empty: true });
    assert.deepStrictEqual(queueEvents(true, { ok: false, reason: "SEAM_UNAVAILABLE" }, T0, false),
      { events: [], empty: null });
  });

  const driver = SH.loadDriver();
  const tc3 = "TC3 missionEvents: baseline done = 0, false -> true = 1, true -> true = 0, pollMs only in the system of "
    + "the player, 4 args unchanged; the watch re-arms missions on a move and offers wallet / queue events";
  const tc4 = "TC4 welcome: NULL = baseline written; >= 1 h away = one line after the login delay (STATIC busy, MODEL "
    + "free); relog after 2 min none; quiet first sight none but written; past welcomeMaxWaitMs dropped";
  if (!driver.ok) {
    for (const n of [tc3, tc4]) skip(n, `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test(tc3, () => {
      const sys = (id) => (id === JITA ? "Jita" : null);
      const opts = (prevDone, playerSystemId) => ({ prevDone, playerSystemId, pollMs: 60000 });
      const base1 = missionEvents([mission({ done: true })], T0, 1800000, sys, opts(null, AMARR));
      assert.deepStrictEqual([base1.events, [...base1.done]], [[], [[`${AGENT}:${T0 + 24 * HOUR}`, true]]]);
      const open = missionEvents([mission()], T0, 1800000, sys, opts(null, AMARR));
      assert.deepStrictEqual([open.nextDueAt, open.hotSystems], [T0 + 24 * HOUR - 1800000, [JITA]], "not here");
      const hot = missionEvents([mission()], T0, 1800000, sys, opts(null, JITA));
      assert.strictEqual(hot.nextDueAt, T0 + 60000, "in the mission system: the short rhythm");
      const done = missionEvents([mission({ done: true })], T0, 1800000, sys, opts(open.done, JITA));
      assert.deepStrictEqual(done.events, [{ kind: "MISSION_OBJECTIVE", key: `mission:${AGENT}:done:${T0 + 24 * HOUR}`,
        payload: { title: "Gone Berserk", system: "Jita" }, occurredAt: T0 }]);
      assert.deepStrictEqual([done.hotSystems, missionEvents([mission({ done: true })], T0, 1800000, sys,
        opts(done.done, JITA)).events], [[], []], "true -> true");
      assert.deepStrictEqual(missionEvents([mission()], T0, 1800000, sys), { events: [],
        nextDueAt: T0 + 24 * HOUR - 1800000 }, "the old call");

      SH.withStore(driver, ({ store }) => {
        const data = { missions: [mission()], wallet: [income(1, "bounty", 3e6, T0 - HOUR)],
          queue: [{ typeId: 3300, toLevel: 2 }] };
        const r = watchRig(store, data);
        r.where.set(PLAYER, AMARR);
        r.watch.runPass();
        r.clock.advance(r.M.watchLoginDelayMs);
        r.watch.runPass();
        assert.deepStrictEqual([r.reads.sort(), r.offers], [["missions", "queue", "wallet"], []], "baselines");
        assert.deepStrictEqual(r.watch.getStatus().sources, ["missions", "wallet", "queue"]);
        r.where.set(PLAYER, JITA);
        r.clock.advance(r.M.watchPollMs);
        r.watch.runPass();
        assert.strictEqual(r.watch.getStatus().counters.missionRearm, 1);
        r.reads.length = 0;
        data.missions = [mission({ done: true })];
        data.wallet = [income(2, "bounty", 4e6, T0 + MINUTE), ...data.wallet];
        data.queue = [];
        r.clock.advance(r.M.skillWatchMs);
        r.watch.runPass();
        r.clock.advance(r.M.walletRescanMs);
        r.watch.runPass();
        assert.ok(r.reads.includes("missions"), JSON.stringify(r.reads));
        assert.deepStrictEqual(r.offers.sort(), ["bounty:2", `mission:${AGENT}:done:${T0 + 24 * HOUR}`,
          `queue:empty:${Math.floor((T0 + r.M.watchLoginDelayMs + r.M.watchPollMs + r.M.skillWatchMs) / MINUTE)}`]
          .sort());
        const c = r.watch.getStatus().counters;
        assert.deepStrictEqual([c.missionObjective, c.queueEmpty, c.events], [1, 1, 3]);
        r.watch.stop();
      });
    });

    test(tc4, async () => {
      await SH.withStoreAsync(driver, async ({ store }) => {
        const repo = createShipAiPrefsRepository();
        const ins = store.transaction("t.watch.insert", (db) => repo.insert(db, { playerId: PLAYER, aiId: AI,
          name: "Jin", nowMs: 1000 }));
        assert.ok(ins.ok && ins.value.ok, JSON.stringify(ins));
        const a = welcomeRig(store, null, { now: T0 });
        a.pass(0);
        assert.strictEqual(a.lastSeen(), T0);
        a.pass(a.M.watchLoginDelayMs);
        a.pass(a.M.watchLoginDelayMs);
        assert.deepStrictEqual([a.delivered, a.p.getStatus().counters.welcomePlanned], [[], 0]);
        a.p.stop();
        const b = welcomeRig(store, null, { now: T0 + 2 * HOUR, lastProactiveAt: T0 + 2 * HOUR });
        b.pass(0);
        b.pass(1000);
        assert.deepStrictEqual(b.delivered, [], "the client loads first");
        b.pass(b.M.watchLoginDelayMs);
        b.pass(b.M.watchLoginDelayMs);
        assert.ok(b.delivered.length === 1 && TRIGGER_TEXT.pl.WELCOME_BACK.includes(b.delivered[0]),
          JSON.stringify(b.delivered));
        const rows = store.transaction("t.watch.rows", (db) => ({ ok: true, rows: db.prepare("SELECT event_key AS k "
          + "FROM ship_ai_events WHERE kind = 'WELCOME_BACK'").all() }));
        assert.deepStrictEqual(rows.value.rows.map((x) => x.k), [`welcome:${T0 + 2 * HOUR}`]);
        b.online.clear();
        b.pass(MINUTE);
        b.online.add(PLAYER);
        b.pass(2 * MINUTE);
        b.pass(b.M.watchLoginDelayMs);
        b.pass(b.M.watchLoginDelayMs);
        const sb = b.p.getStatus().counters;
        assert.deepStrictEqual([b.delivered.length, sb.welcomePlanned, sb.welcomeLines, sb.seenWriteFailed],
          [1, 1, 1, 0]);
        const away = b.now();
        b.p.stop();
        const c = welcomeRig(store, null, { now: away + 3 * HOUR });
        c.pass(0);
        c.pass(c.M.watchLoginDelayMs);
        await flush();
        const data = c.requests.length === 1 ? c.requests[0].messages[1].content : "";
        assert.ok(data.includes("\"kind\":\"WELCOME_BACK\"") && data.includes("\"hours\":3"), data);
        assert.deepStrictEqual(c.delivered, ["Witaj z powrotem, kapitanie. Szkolenie gotowe."]);
        c.p.stop();
        const q = welcomeRig(store, null, { now: c.now() + 5 * HOUR, quiet: true });
        q.pass(0);
        assert.strictEqual(q.lastSeen(), q.now());
        q.pass(q.M.watchLoginDelayMs);
        assert.deepStrictEqual([q.delivered, q.p.getStatus().counters.welcomePlanned], [[], 0]);
        q.p.stop();
        const e = welcomeRig(store, null, { now: q.now() + 5 * HOUR });
        e.pass(0);
        e.pass(e.M.welcomeMaxWaitMs + 1);
        const se = e.p.getStatus();
        assert.deepStrictEqual([e.delivered, se.counters.welcomePlanned, se.counters.welcomeExpired, se.welcome.due],
          [[], 1, 1, 0]);
        e.p.stop();
      });
    });
  }

  test("TC5 readWalletIncomeFrom: +CASH of six types, own of ownerID2, peek fallback, foreign projection; vendor "
    + "facts; the bad welcome pair = one warning and the defaults", () => {
    const walletState = { JOURNAL_ENTRY_TYPE: { PLAYER_DONATION: 10, NPC_BOUNTY_PRIZE: 17, INSURANCE: 19,
      AGENT_MISSION_REWARD: 33, AGENT_MISSION_TIME_BONUS_REWARD: 34, NPC_BOUNTY_PRIZES: 85, MARKET_TRANSACTION: 2 },
    ACCOUNT_KEY: { CASH: 1000 } };
    const e = (id, type, amount, ms, over) => ({ transactionID: id, transactionDate: fileTime(ms), entryTypeID: type,
      ownerID1: 1000125, ownerID2: PLAYER, accountKey: 1000, amount, description: "secret", ...(over || {}) });
    const journal = [e(1, 85, 2e6, T0), e(2, 19, -3e5, T0 - 1), e(3, 2, 5e6, T0 - 2), e(4, 17, 1e6, T0 - 3,
      { accountKey: 1001 }), e(5, 10, 7e6, T0 - 4, { ownerID2: OTHER }), e(6, 33, 4e6, T0 - 5), e(7, 34, 1e6, T0 - 6),
    e(8, 19, 9e6, T0 - 7), e(9, 17, 1e6, T0, { transactionDate: null }), e("x", 17, 1e6, T0 - 8)];
    const mods = { walletProjection: { getCharacterProjection: () => ({ characterID: PLAYER, walletJournal: journal }) },
      characterState: { peekCharacterRecord: () => null }, walletState };
    const r = readWalletIncomeFrom(mods, PLAYER);
    assert.deepStrictEqual(r, { ok: true, entries: [
      { transactionId: 1, source: "bounty", amountIsk: 2e6, atMs: T0, own: true },
      { transactionId: 5, source: "donation", amountIsk: 7e6, atMs: T0 - 4, own: false },
      { transactionId: 6, source: "mission", amountIsk: 4e6, atMs: T0 - 5, own: true },
      { transactionId: 7, source: "mission", amountIsk: 1e6, atMs: T0 - 6, own: true },
      { transactionId: 8, source: "insurance", amountIsk: 9e6, atMs: T0 - 7, own: true }] });
    assert.ok(!JSON.stringify(r).includes("secret") && !JSON.stringify(r).includes("1000125"), "no secret or wallet id leaks");
    const peek = readWalletIncomeFrom({ ...mods, walletProjection: { getCharacterProjection: () => null },
      characterState: { peekCharacterRecord: () => ({ walletJournal: [e(1, 85, 2e6, T0)] }) } }, PLAYER);
    assert.deepStrictEqual(peek.entries.map((x) => x.transactionId), [1], "peek fallback");
    assert.deepStrictEqual(readWalletIncomeFrom({ ...mods, walletProjection: { getCharacterProjection: () => ({
      characterID: OTHER, walletJournal: journal }) } }, PLAYER), { ok: false, reason: "NO_RECORD" });
    assert.deepStrictEqual(readWalletIncomeFrom({ ...mods, walletState: null }, PLAYER),
      { ok: false, reason: "SEAM_UNAVAILABLE" });

    const src = (rel) => fs.readFileSync(path.join(SERVER_SRC, ...rel.split("/")), "utf8").replace(/\r\n/g, "\n");
    const ws = src("services/account/walletState.js");
    for (const line of ["  PLAYER_DONATION: 10,", "  NPC_BOUNTY_PRIZE: 17,", "  INSURANCE: 19,",
      "  AGENT_MISSION_REWARD: 33,", "  AGENT_MISSION_TIME_BONUS_REWARD: 34,", "  NPC_BOUNTY_PRIZES: 85,"]) {
      assert.ok(ws.split("\n").includes(line), line);
    }
    assert.ok(src("services/account/plexVaultLogState.js")
      .includes("return Date.now() * 1000 + Math.floor(Math.random() * 1000);"), "IDs not monotonic");
    assert.ok(src("services/agent/missionRuntimeState.js")
      .includes("objectiveCompleted: toBoolean(record.objectiveCompleted, false),"));
    assert.ok(src("services/agent/missionRewardSettlementState.js").includes("ownerID2: settlement.characterID,"));

    assert.deepStrictEqual(welcomeDecision(null, T0, false, settings()).reason, "NEW");
    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1",
      EVEJS_LNE_SHIP_AI_WELCOME_MIN_OFFLINE_MS: "60000", EVEJS_LNE_SHIP_AI_WELCOME_SEEN_WRITE_MS: "300000" } });
    assert.strictEqual(bad.warnings.filter((w) => w.includes("welcomeSeenWriteMs")).length, 1);
    assert.deepStrictEqual([bad.config.shipAi.welcomeMinOfflineMs, bad.config.shipAi.welcomeSeenWriteMs],
      [3600000, 300000]);
  });

  test("TC6 of triggers-b: an entry that aged out without its line starts no cooldown; a waiting entry of the "
    + "kind suppresses a second fact", () => {
    const M = { ...settings(), notableClasses: parseNameList("Battleship"), notablePatterns: parseNameList("Officer"),
      muted: new Set() };
    const cargo = (at) => activityEntryOf({ type: "mining", reason: "cargo", shipId: 990001, systemId: JITA,
      atMs: at }, { system: () => "Jita" }, M);
    const a = noteActivity(emptyTriggerState(), [cargo(T0)], T0, M);
    const b = noteActivity(a.state, [cargo(T0 + MINUTE)], T0 + MINUTE, M);
    assert.deepStrictEqual([a.queued, b.queued, b.suppressed], [1, 0, 1], "one entry of the kind waits");
    b.state.pending.clear();
    const c = noteActivity(b.state, [cargo(T0 + 2 * MINUTE)], T0 + 2 * MINUTE, M);
    assert.strictEqual(c.queued, 1, "aged out without a line: no cooldown");
  });

  test("TC7: a mission accepted and done between two reads = 1 MISSION_OBJECTIVE on a full list, 0 at "
    + "the baseline and 0 on a truncated list: MISSION_EXPIRING on the default path (objective on)", () => {
    const sys = (id) => (id === JITA ? "Jita" : null);
    const key = `mission:${AGENT}:done:${T0 + 24 * HOUR}`;
    const opts = (prevDone, complete) => ({ prevDone, playerSystemId: AMARR, pollMs: 60000, complete });
    const quick = [mission({ done: true })];
    assert.deepStrictEqual(missionEvents(quick, T0, 1800000, sys, opts(new Map(), true)).events.map((e) => e.key),
      [key], "new key already done");
    assert.deepStrictEqual(missionEvents(quick, T0, 1800000, sys, opts(null, true)).events, [], "baseline (login)");
    assert.deepStrictEqual(missionEvents(quick, T0, 1800000, sys, opts(new Map(), false)).events, [], "truncated");
    const seen = new Map([[`${AGENT}:${T0 + 24 * HOUR}`, true]]);
    assert.deepStrictEqual(missionEvents(quick, T0, 1800000, sys, opts(seen, true)).events, [], "true -> true");
    const soon = mission({ expiresAtMs: T0 + 20 * MINUTE });
    const exp = missionEvents([soon], T0, 1800000, sys, opts(new Map(), true));
    assert.deepStrictEqual(exp.events, [{ kind: "MISSION_EXPIRING", key: `mission:${AGENT}:${T0 + 20 * MINUTE}`,
      payload: { title: "Gone Berserk", system: "Jita", minutesLeft: 20 }, occurredAt: T0,
      expiresAt: T0 + 20 * MINUTE }]);
    assert.deepStrictEqual([...exp.done], [[`${AGENT}:${T0 + 20 * MINUTE}`, false]]);
  });

  const tc8 = "TC8 (c review): a refused first queue read keeps the login flag (the next empty read = login key)";
  if (!driver.ok) {
    skip(tc8, `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test(tc8, () => {
      SH.withStore(driver, ({ store }) => {
        const data = { missions: [], wallet: [], queue: [], queueRefused: true };
        const r = watchRig(store, data);
        r.where.set(PLAYER, AMARR);
        r.watch.runPass();
        r.clock.advance(r.M.watchLoginDelayMs);
        r.watch.runPass();
        assert.ok(r.reads.includes("queue"), JSON.stringify(r.reads));
        assert.deepStrictEqual(r.offers, [], "refused");
        data.queueRefused = false;
        r.clock.advance(r.M.watchRescanMs);
        r.watch.runPass();
        const day = Math.floor((T0 + r.M.watchLoginDelayMs + r.M.watchRescanMs) / 86400000);
        assert.deepStrictEqual(r.offers, [`queue:empty:login:${day}`]);
        r.watch.stop();
      });
    });
  }
};
