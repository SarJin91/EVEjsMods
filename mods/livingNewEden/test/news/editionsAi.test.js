"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { resolveConfig } = require("../../config");
const { startNews } = require("../../lib/news");
const { loadDriver, withStoreAsync } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const B = Date.UTC(2026, 10, 15, 17, 0, 0);
const H = 3600000;
const DAY = 24 * H;
const SYS = 30000142;
const NAMES = new Map([[500001, "Caldari State"], [500002, "Gallente Federation"]]);
const graph = Object.freeze({
  getSystem: (id) => (id === SYS ? { systemId: id, name: "Jita", regionId: 10000002 } : null),
  getSystemIds: () => [SYS],
  getRegionIds: () => [10000002],
  getRegionName: () => "The Forge",
});
const GOOD = "TITLE: Jita changes hands\n\nThe Caldari State took control of Jita in The Forge from the Gallente "
  + "Federation.\n\nThe Forge waits for the next move of both empires.";
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeChatterAi() {
  const calls = [];
  const ai = { calls, gate: null, getStatus: () => ({ state: "running" }), complete(spec) {
    const call = { spec, resolve: null };
    calls.push(call);
    if (ai.gate) return Promise.resolve({ ok: false, reason: ai.gate });
    if (spec.onAccepted() === false) return Promise.resolve({ ok: false, reason: "ABORTED" });
    return new Promise((resolve) => {
      call.resolve = resolve;
    });
  } };
  return ai;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    for (const n of ["EA1", "EA2"]) skip(`${n} news AI (store)`, `no sqlite driver: ${driver.detail}`);
    return;
  }

  const config = (() => {
    const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NEWS_ENABLED: "1", EVEJS_LNE_NEWS_AI_ENABLED: "1",
      EVEJS_LNE_NEWS_MIN_BODY_CHARS: "50" } });
    assert.ok(r.ok, JSON.stringify(r.errors));
    return r.config;
  })();
  const settle = config.news.settleDelayMs;

  function rig(opened, t0) {
    const clock = createManualClock(t0);
    const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
    const ai = fakeChatterAi();
    let listener = null;
    const lines = [];
    const ctx = { persistence: { ok: true, store: opened.store, journal }, graph: { getGraph: () => ({ ok: true, graph }) },
      chatterAi: ai, notices: { onWarEvents: (fn) => {
        listener = fn;
        return { ok: true, unsubscribe: () => {} };
      } } };
    const start = () => {
      const r = startNews({ config, ctx, adapter: { readFactionNames: () => ({ ok: true, names: NAMES }) }, clock,
        logger: { log: (l) => lines.push(l) }, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
      assert.ok(r.ok, JSON.stringify(r));
      return r.news;
    };
    const fact = (key, kind, at) => listener([{ eventKey: key, kind, systemId: SYS, at, attackerName: "Caldari State",
      defenderName: "Gallente Federation", systemName: "Jita", regionName: "The Forge", recipients: [], outcome: null }]);
    const edition = (news, boundaryAt) => news.listEditions({ limit: 10 }).editions.find((e) => e.boundaryAt === boundaryAt);
    return { clock, ai, ctx, lines, start, fact, edition };
  }

  test("EA1 news AI: success -> READY(AI) then PUBLISHED(AI); two rejections -> FALLBACK with ai_reason; a gate "
    + "refusal spends no attempt", () => withStoreAsync(driver, async (opened) => {
    const r = rig(opened, B - 3 * H);
    const news = r.start();
    r.fact("occ:1", "SYSTEM_CAPTURED", B - H);
    news.runPassNow(B + settle);
    assert.strictEqual(r.ai.calls.length, 1, "one request");
    const spec = r.ai.calls[0].spec;
    assert.deepStrictEqual([spec.lane, spec.messages.length, spec.minChars], ["news", 2, 50]);
    assert.ok(spec.messages[1].content.includes("F1 | System captured | Jita (The Forge)"), spec.messages[1].content);
    let e = r.edition(news, B);
    assert.deepStrictEqual([e.state, e.aiAttempts], ["DRAFTING", 1], "the attempt is counted before the result");
    assert.strictEqual(news.getStatus().ai.state, "drafting");
    news.runPassNow(B + settle + 60000);
    assert.strictEqual(r.ai.calls.length, 1, "in flight: no second request");
    r.ai.calls[0].resolve({ ok: true, text: GOOD, tokens: 321, ms: 10 });
    await flush();
    e = r.edition(news, B);
    assert.deepStrictEqual([e.state, e.source, e.title, e.paragraphs.length, e.tokens], ["READY", "AI",
      "Jita changes hands", 2, 321]);
    news.runPassNow(B + settle + 120000);
    assert.deepStrictEqual([r.edition(news, B).state, r.edition(news, B).source], ["PUBLISHED", "AI"]);

    const B2 = B + DAY;
    r.fact("occ:2", "ATTACK_STARTED", B2 - H);
    r.ai.gate = "RATE_LIMITED";
    news.runPassNow(B2 + settle);
    await flush();
    assert.deepStrictEqual([r.ai.calls.length, r.edition(news, B2).aiAttempts], [2, 0], "a gate refusal is no attempt");
    r.ai.gate = null;
    news.runPassNow(B2 + settle + 60000);
    assert.strictEqual(r.ai.calls.length, 3);
    r.ai.calls[2].resolve({ ok: false, reason: "REJECTED_CHARSET", tokens: 40 });
    await flush();
    e = r.edition(news, B2);
    assert.deepStrictEqual([e.state, e.aiAttempts, e.aiReason, e.tokens], ["DRAFTING", 1, "REJECTED_CHARSET", 40]);
    news.runPassNow(B2 + settle + 120000);
    assert.strictEqual(r.ai.calls.length, 4, "the second attempt");
    r.ai.calls[3].resolve({ ok: true, text: GOOD.replace("next move", "99 ships"), tokens: 60 });
    await flush();
    e = r.edition(news, B2);
    assert.deepStrictEqual([e.state, e.source, e.aiAttempts, e.aiReason, e.tokens, e.title],
      ["READY", "FALLBACK", 2, "NUMBER_UNSOURCED", 100, e.fallbackTitle]);
    news.runPassNow(B2 + settle + 180000);
    assert.deepStrictEqual([r.ai.calls.length, r.edition(news, B2).state], [4, "PUBLISHED"], "no third request");
    const st = news.getStatus();
    assert.deepStrictEqual([st.aiRequests, st.aiAccepted, st.aiRejected, st.ai.lastReason, st.ai.state],
      [3, 1, 2, "NUMBER_UNSOURCED", "idle"]);
    const logText = r.lines.join("\n");
    assert.ok(!logText.includes("Jita changes") && !logText.includes("FACTS"), "no prompt or text in a log");
    news.stop("test");
  }));

  test("EA2 news AI: restart at ai_attempts 1 -> one more request then FALLBACK, the stopped instance's result "
    + "dropped; the draft deadline -> FALLBACK, the late result STALE", () => withStoreAsync(driver, async (opened) => {
    const r = rig(opened, B - 3 * H);
    const first = r.start();
    r.fact("occ:3", "SYSTEM_CAPTURED", B - H);
    first.runPassNow(B + settle);
    assert.deepStrictEqual([r.ai.calls.length, r.edition(first, B).aiAttempts], [1, 1]);
    first.stop("crash");
    const second = r.start();
    second.runPassNow(B + settle + 60000);
    assert.deepStrictEqual([r.ai.calls.length, r.edition(second, B).aiAttempts], [2, 2], "exactly one more request");
    r.ai.calls[0].resolve({ ok: true, text: GOOD, tokens: 5 });
    await flush();
    assert.strictEqual(r.edition(second, B).state, "DRAFTING", "the stopped instance's result is dropped");
    r.ai.calls[1].resolve({ ok: false, reason: "TIMEOUT" });
    await flush();
    let e = r.edition(second, B);
    assert.deepStrictEqual([e.state, e.source, e.aiReason], ["READY", "FALLBACK", "TIMEOUT"]);
    second.runPassNow(B + settle + 120000);
    assert.deepStrictEqual([r.ai.calls.length, r.edition(second, B).state], [2, "PUBLISHED"]);

    const B2 = B + DAY;
    r.fact("occ:4", "SYSTEM_CAPTURED", B2 - H);
    second.runPassNow(B2 + settle);
    assert.strictEqual(r.ai.calls.length, 3);
    second.runPassNow(B2 + settle + config.news.draftDeadlineMs + 1);
    e = r.edition(second, B2);
    assert.deepStrictEqual([e.state, e.source, e.aiReason], ["PUBLISHED", "FALLBACK", "DEADLINE"]);
    r.ai.calls[2].resolve({ ok: true, text: GOOD, tokens: 7 });
    await flush();
    const after = r.edition(second, B2);
    assert.deepStrictEqual([after.source, after.title, after.paragraphs, after.tokens, after.version],
      [e.source, e.title, e.paragraphs, e.tokens, e.version], "the late result changes nothing");
    assert.ok(r.lines.some((l) => l.includes("ai result STALE")), r.lines.join("\n"));
    second.stop("test");
  }));
};
