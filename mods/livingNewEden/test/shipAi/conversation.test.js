"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { createShipAiClient } = require("../../lib/shipAi/client");
const { createConversation, createDeliver } = require("../../lib/shipAi/conversation");
const { createShipAiTurnsRepository } = require("../../lib/shipAi/turnsRepository");
const { buildSnapshot, createContextState } = require("../../lib/shipAi/context");
const { STATIC, DATA_RULE } = require("../../lib/shipAi/data/persona");
const { startShipAi } = require("../../lib/shipAi");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PLAYER = 9001;
const OTHER = 9002;
const AI = 91000001;
const KEY = "test-key-not-real-0123";
const JITA = 30000142;
const STATION = "Jita IV - Moon 4 - Caldari Navy Assembly Plant";

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;

function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const completion = (content, total = 120) => ({ ok: true, status: 200,
  json: { choices: [{ message: { content }, finish_reason: "stop" }], usage: { total_tokens: total } } });

function deferredTransport() {
  const calls = [];
  return {
    calls,
    post(spec) {
      return new Promise((resolve) => calls.push({ spec, body: JSON.parse(spec.body), resolve }));
    },
  };
}

function fakeAdapter(state = "docked") {
  return {
    readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER, name: "Pilot One", systemId: JITA, state },
      { characterId: OTHER, name: "Pilot Two", systemId: JITA, state: "space" }] }),
    readStaticMap: () => ({ ok: true, map: { systems: [{ id: JITA, name: "Jita", secClass: "highsec",
      regionId: 10000002 }], regionNames: new Map([[10000002, "The Forge"]]) } }),
    listNpcStationsInSystem: () => ({ ok: true, stations: [{ stationId: 60003760, name: STATION }] }),
  };
}

function fakeTimer() {
  const timers = [];
  const setTimer = (fn, ms) => {
    const t = { fn, ms, cancelled: false, cancel() { this.cancelled = true; }, hasRef: () => false };
    timers.push(t);
    return t;
  };
  return { timers, setTimer, live: () => timers.filter((t) => !t.cancelled) };
}

function rig(store, opts = {}) {
  const S2 = settings(opts.S);
  let now = 1700000000000;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const transport = opts.transport || deferredTransport();
  const logs = [];
  const metrics = [];
  const logger = { log: (line) => logs.push(String(line)) };
  const telemetry = { count: (name, n) => metrics.push(`${name}=${n}`),
    observe: (name, v) => metrics.push(`${name}~${v}`) };
  const room = [];
  const system = [];
  const roomResult = opts.roomResult || { ok: true, sockets: 1 };
  const adapter = fakeAdapter();
  const client = createShipAiClient({ S: S2, apiKey: opts.apiKey === undefined ? KEY : opts.apiKey, transport,
    nowMs: clock.now, telemetry, logger });
  const deliver = createDeliver({ pairOf: (id) => (id === PLAYER || id === OTHER ? { aiId: AI } : null),
    nameOf: () => "Jin",
    sendAiMessage: (spec) => {
      room.push(spec);
      return roomResult;
    },
    readPresence: adapter.readPresence,
    sendCharacterSystemLine: (spec) => {
      system.push(spec);
      return { ok: true };
    } });
  const timer = fakeTimer();
  const ctxState = createContextState();
  const conv = createConversation({ S: S2, client, store, turnsRepo: createShipAiTurnsRepository(S2),
    nowMs: clock.now, setTimer: timer.setTimer, telemetry, logger, nameOf: () => "Jin", deliver,
    snapshot: (id) => buildSnapshot({ adapter, nowMs: clock.now, S: S2, state: ctxState }, id) });
  return { S: S2, clock, transport, logs, metrics, room, system, client, conv, timer,
    rows: (id = PLAYER) => {
      const r = store.transaction("t.read", (db) => createShipAiTurnsRepository(S2).listRecent(db, id, 100));
      assert.ok(r.ok && r.value.ok, JSON.stringify(r));
      return r.value.rows.map((x) => [x.seq, x.role, x.text]);
    } };
}

module.exports = ({ test, skip }) => {
  const driver = SH.loadDriver();
  const names = {
    c1: "C1 happy path: reply -> room, exchange in ship_ai_turns (two rows, prune to turnsKeep), prompt = persona + "
      + "DATA snapshot + history + user; body nemotron + enable_thinking false; migration 85, reset KEEP",
    c3: "C3 dailyTokenBudget 0 / perCharacterDailyTokens 0 / breaker OPEN -> static TIRED, zero transport calls",
    c4: "C4 queue: 3 lines in flight -> ONE more request with the joined text; over maxPendingChars -> BUSY; "
      + "cooldown arms the poller; maxInFlight 1 holds the second character until the first ends",
    c5: "C5 spy: no text of the player / model and no key in any log line or metric; NO_ROOM -> system line",
    c6: "C6 shared key: chatterAi 10 + shipAi 30 > 36 -> one WARN at start (no key in it); 10 + 20 -> none",
    c7: "C7: a room line of a character outside allowCharacterIds -> static OFFLINE, zero transport calls, no "
      + "turn, out of the vendor backlog",
    c8: "C8: a SQL error mid-exchange throws the sentinel -> TX_ABORTED, the whole exchange rolled back",
  };
  if (!driver.ok) {
    for (const n of Object.values(names)) skip(n, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test(names.c1, () => SH.withStoreAsync(driver, async ({ store }) => {
    const { MIGRATIONS } = require("../../lib/persistence/migrations");
    const { TABLE_POLICY } = require("../../lib/persistence/worldReset");
    const m = MIGRATIONS.find((x) => x.name === "ship_ai_turns");
    assert.ok(m && m.version >= 85, "migration ship_ai_turns");
    assert.strictEqual(TABLE_POLICY.ship_ai_turns, "KEEP");

    const r = rig(store, { S: { turnsKeep: 4, minIntervalMs: 0 } });
    r.conv.onMessage(PLAYER, "Earlier question");
    r.transport.calls[0].resolve(completion("Earlier answer."));
    await flush();
    r.conv.onMessage(PLAYER, "  hello\u0007 Jin  ");
    assert.strictEqual(r.transport.calls.length, 2);
    const call = r.transport.calls[1];
    assert.strictEqual(call.spec.apiKey, KEY);
    assert.strictEqual(String(call.spec.url), "https://integrate.api.nvidia.com/v1/chat/completions");
    assert.deepStrictEqual([call.body.model, call.body.chat_template_kwargs, call.body.max_tokens, call.body.stream],
      ["nvidia/nemotron-3.5-super-vl-120b-a12b", { enable_thinking: false }, 400, false]);
    const msgs = call.body.messages;
    assert.deepStrictEqual(msgs.map((x) => x.role), ["system", "system", "user", "assistant", "user"]);
    assert.ok(msgs[0].content.includes("You are Jin, the onboard intelligence") && msgs[0].content.includes("Pilot One")
      && msgs[0].content.endsWith(DATA_RULE) && msgs[0].content.includes("at most 3 chat lines"), msgs[0].content);
    assert.strictEqual(msgs[1].content, `DATA {"snapshot":{"system":"Jita","security":"highsec","region":"The Forge",`
      + `"where":"docked:${STATION}"}}`);
    assert.deepStrictEqual(msgs.slice(2).map((x) => x.content), ["Earlier question", "Earlier answer.", "hello Jin"]);

    call.resolve(completion("Hello captain. <think>plan</think>Jita looks busy today."));
    await flush();
    assert.deepStrictEqual(r.room.slice(1), [{ playerId: PLAYER, aiId: AI,
      text: "Hello captain. Jita looks busy today." }]);
    assert.deepStrictEqual(r.rows(), [[1, "user", "Earlier question"], [2, "assistant", "Earlier answer."],
      [3, "user", "hello Jin"], [4, "assistant", "Hello captain. Jita looks busy today."]]);
    r.conv.onMessage(PLAYER, "third");
    r.transport.calls[2].resolve(completion("Third answer."));
    await flush();
    assert.deepStrictEqual(r.rows().map((x) => x[0]), [3, 4, 5, 6], "pruned to turnsKeep in the same tx");
    const st = r.client.getStatus();
    assert.deepStrictEqual([st.counters.requests, st.tokensToday, st.breaker], [3, 360, "closed"]);
    assert.deepStrictEqual(r.conv.getStatus().counters.replies, 3);
    r.conv.stop();
    r.client.stop();
  }));

  test(names.c3, () => SH.withStoreAsync(driver, async ({ store }) => {
    for (const over of [{ dailyTokenBudget: 0 }, { perCharacterDailyTokens: 0 }]) {
      const r = rig(store, { S: { ...over, minIntervalMs: 0 } });
      r.conv.onMessage(PLAYER, "hi");
      await flush();
      assert.strictEqual(r.transport.calls.length, 0, JSON.stringify(over));
      assert.ok(STATIC.en.TIRED.includes(r.room[0].text), r.room[0].text);
      r.conv.stop();
    }
    const r = rig(store, { S: { breakerFailures: 1, minIntervalMs: 0 } });
    r.conv.onMessage(PLAYER, "hi");
    r.transport.calls[0].resolve({ ok: false, reason: "NET_ERROR" });
    await flush();
    assert.ok(STATIC.en.SIGNAL_LOST.includes(r.room[0].text));
    assert.strictEqual(r.client.getStatus().breaker, "open");
    r.conv.onMessage(PLAYER, "again");
    await flush();
    assert.strictEqual(r.transport.calls.length, 1, "no request while OPEN");
    assert.ok(STATIC.en.TIRED.includes(r.room[1].text));
    assert.deepStrictEqual(r.rows(), [], "a failure writes no exchange");
    r.conv.stop();
  }));

  test(names.c4, () => SH.withStoreAsync(driver, async ({ store }) => {
    const r = rig(store, { S: { minIntervalMs: 4000, maxInFlight: 1, maxPendingChars: 20 } });
    r.conv.onMessage(PLAYER, "first");
    for (const t of ["m2", "m3", "m4"]) r.conv.onMessage(PLAYER, t);
    assert.strictEqual(r.transport.calls.length, 1);
    r.conv.onMessage(PLAYER, "x".repeat(20));
    assert.ok(STATIC.en.BUSY.includes(r.room[0].text), "over maxPendingChars -> BUSY");
    r.conv.onMessage(OTHER, "other pilot");
    assert.strictEqual(r.transport.calls.length, 1, "maxInFlight 1: the second character waits");
    r.clock.advance(1000);
    r.transport.calls[0].resolve(completion("Answer one."));
    await flush();
    assert.strictEqual(r.transport.calls.length, 2);
    assert.strictEqual(r.transport.calls[1].body.messages.at(-1).content, "other pilot");
    assert.ok(r.timer.live().some((t) => t.ms === 3000), JSON.stringify(r.timer.live().map((t) => t.ms)));
    r.transport.calls[1].resolve(completion("Answer two."));
    await flush();
    r.clock.advance(3000);
    const due = r.timer.live().find((t) => t.ms === 3000);
    due.cancelled = true;
    due.fn();
    await flush();
    assert.strictEqual(r.transport.calls.length, 3, "one more request for the three pending lines");
    assert.strictEqual(r.transport.calls[2].body.messages.at(-1).content, "m2\nm3\nm4");
    r.transport.calls[2].resolve(completion("Answer three."));
    await flush();
    assert.deepStrictEqual(r.rows().filter((x) => x[1] === "user").map((x) => x[2]), ["first", "m2\nm3\nm4"]);
    const st = r.conv.getStatus();
    assert.deepStrictEqual([st.inFlight, st.waiting, st.pending, st.counters.busy, st.counters.requests],
      [0, 0, 0, 1, 3]);
    r.conv.stop();
  }));

  test(names.c5, () => SH.withStoreAsync(driver, async ({ store }) => {
    const r = rig(store, { S: { minIntervalMs: 0 }, roomResult: { ok: false, reason: "NO_ROOM" } });
    const secrets = ["PlayerSecretWord", "ModelSecretWord", KEY];
    r.conv.onMessage(PLAYER, "tell me PlayerSecretWord");
    r.transport.calls[0].resolve(completion("Fine, ModelSecretWord, captain."));
    await flush();
    assert.deepStrictEqual(r.system, [{ characterId: PLAYER, systemId: JITA,
      text: "Jin: Fine, ModelSecretWord, captain." }], "NO_ROOM -> a system line to his session");
    r.conv.onMessage(PLAYER, "PlayerSecretWord again");
    r.transport.calls[1].resolve(completion("Let us talk about sex, ModelSecretWord."));
    await flush();
    assert.ok(STATIC.en.DEFLECT.some((l) => r.system[1].text === `Jin: ${l}`), r.system[1].text);
    r.conv.onMessage(PLAYER, "PlayerSecretWord 3");
    r.transport.calls[2].resolve({ ok: false, reason: "HTTP_STATUS", status: 401, retryAfterMs: null });
    await flush();
    r.conv.onMessage(PLAYER, "PlayerSecretWord 4");
    await flush();
    const statusText = JSON.stringify([r.client.getStatus(), r.conv.getStatus()]);
    for (const text of [...r.logs, ...r.metrics, statusText]) {
      for (const s of secrets) assert.ok(!text.includes(s), `"${s}" leaked: ${text}`);
    }
    assert.ok(r.logs.includes("shipAi client: disabled - AUTH_REJECTED"), JSON.stringify(r.logs));
    assert.ok(r.metrics.includes("shipAi.replies=1") && r.metrics.includes("shipAi.rejected=1")
      && r.metrics.includes("shipAi.failed=1"), JSON.stringify(r.metrics));
    assert.strictEqual(r.transport.calls.length, 3, "disabled -> no 4th request");
    r.conv.stop();
  }));

  test(names.c6, () => SH.withStoreAsync(driver, async (persistence) => {
    const run = (chatterRpm, shipRpm, ownKey) => {
      const logs = [];
      const config = { ...base, chatterAi: { ...base.chatterAi, enabled: true, apiKey: KEY,
        maxRequestsPerMinute: chatterRpm },
      shipAi: { ...base.shipAi, channel: "local", allowCharacterIds: "*", maxRequestsPerMinute: shipRpm,
        apiKey: ownKey } };
      const adapter = { shipAiSeams: () => ({ ok: true, seam: { identities: { corporationExists: () => ({ ok: true,
        exists: true }) }, xmpp: {}, channel: () => null } }),
      installChatCommand: () => ({ ok: true }), uninstallChatCommand: () => ({ ok: true }) };
      const started = startShipAi({ config, persistence, adapter, clock: { now: () => 1000 },
        logger: { log: (l) => logs.push(String(l)) }, setTimer: fakeTimer().setTimer });
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      started.shipAi.stop("test");
      assert.ok(logs.every((l) => !l.includes(KEY)), "no key in the log");
      return logs.filter((l) => l.includes("WARN")).length;
    };
    assert.strictEqual(run(10, 30, ""), 1);
    assert.strictEqual(run(10, 20, ""), 0);
    assert.strictEqual(run(10, 30, "another-test-key"), 0, "own key -> no shared limit");
  }));

  test(names.c7, () => SH.withStoreAsync(driver, async (persistence) => {
    const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
    const ins = persistence.store.transaction("t.prefs", (db) => createShipAiPrefsRepository().insert(db,
      { playerId: PLAYER, aiId: AI, name: "Jin", nowMs: 1000 }));
    assert.ok(ins.ok && ins.value.ok, JSON.stringify(ins));
    const transport = deferredTransport();
    const room = [];
    let hooks = null;
    const xmpp = { isInstalled: () => true, userDataOf: () => "<x/>", registerPair: () => ({ ok: true }),
      sendAiMessage: (spec) => { room.push(spec.text); return { ok: true }; }, getState: () => ({ rooms: 1 }),
      clearPairs: () => {} };
    const adapter = { shipAiSeams: () => ({ ok: true, seam: { identities: { corporationExists: () => ({ ok: true,
      exists: true }) }, xmpp, channel: (h) => { hooks = h; return { install: () => ({ ok: true }), uninstall() {} }; } } }),
    installChatCommand: () => ({ ok: true }), uninstallChatCommand: () => ({ ok: true }), ...fakeAdapter() };
    const config = { ...base, shipAi: { ...base.shipAi, channel: "private", allowCharacterIds: String(OTHER),
      apiKey: KEY, minIntervalMs: 0 } };
    const started = startShipAi({ config, persistence, adapter, transport, clock: { now: () => 5000 },
      logger: { log() {} }, setTimer: fakeTimer().setTimer });
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    const roomName = `private_${Math.min(PLAYER, AI)}_${Math.max(PLAYER, AI)}`;
    assert.strictEqual(hooks.isAiRoom(roomName, PLAYER), true, "the line is taken out of the vendor backlog");
    hooks.onRoomMessage(PLAYER, "hello there");
    await flush();
    assert.strictEqual(transport.calls.length, 0, "no request");
    assert.deepStrictEqual(room, [STATIC.en.OFFLINE[0]]);
    const turns = persistence.store.transaction("t.read", (db) => createShipAiTurnsRepository(settings())
      .listRecent(db, PLAYER, 10));
    assert.deepStrictEqual(turns.value.rows, [], "no turn saved");
    assert.strictEqual(started.shipAi.getStatus().counters.roomDenied, 1);
    started.shipAi.stop("test");
  }));

  test(names.c8, () => SH.withStoreAsync(driver, async ({ store }) => {
    const repo = createShipAiTurnsRepository(settings());
    let inserts = 0;
    const res = store.transaction("t.append", (db) => repo.appendExchangeInTx({ inTransaction: true,
      prepare: (sql) => {
        const st = db.prepare(sql);
        if (!sql.startsWith("INSERT")) return st;
        return { run: (...a) => {
          inserts += 1;
          if (inserts === 2) throw new Error("boom");
          return st.run(...a);
        } };
      } }, { playerId: PLAYER, userText: "u", aiText: "a", nowMs: 1000 }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "TX_ABORTED", JSON.stringify(res));
    assert.strictEqual(repo.lastAppendFailure().reason, "SHIP_AI_SQL_FAILED");
    const rows = store.transaction("t.read", (db) => repo.listRecent(db, PLAYER, 10));
    assert.deepStrictEqual(rows.value.rows, [], "the user row is rolled back too");
  }));
};
