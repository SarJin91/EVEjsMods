"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { startChatterAi } = require("../../lib/chatterAi");
const { filterPlotText, filterPlotField } = require("../../lib/chatterAi/filter");
const { createGameMasterService } = require("../../lib/gameMaster/service");
const { createGameMasterRepository } = require("../../lib/gameMaster/repository");
const { cycleAtOrBefore } = require("../../lib/gameMaster/cycle");
const { buildOffer } = require("../../lib/gameMaster/digest");
const { buildPlotPrompt, readHints, factsOf, SYSTEM_PROMPT } = require("../../lib/gameMaster/ai");
const { createNewsRepository } = require("../../lib/news/repository");
const { createUnavailableNews } = require("../../lib/news");
const { createJournal } = require("../../lib/persistence/journal");
const { loadDriver, withStore, withStoreAsync } = require("../notices/storeHelper");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const T0 = 1763568000000 + HOUR;
const KEY = "nvapi-SECRET-TEST-KEY";
const PLAYER = Object.freeze({ characterId: 90000001, name: "Pilot Zed" });
const FACTS = Object.freeze([
  { kind: "PLAYER_SOV_LOST", at: T0 - HOUR, systemId: 30000002, text: "Rakka (Alpha Reach): Evil Player Corp lost." },
  { kind: "BOUNTY_CLAIMED", at: T0 - HOUR, systemId: null, text: "Hunter Bob claimed a bounty." },
  { kind: "BATTLE", at: T0 - HOUR, systemId: 30000011, text: "Kor-Azor (Beta Drift): a battle of the pirates." },
]);
const HINT = "A crisis grows in Beta Drift.";
const flush = () => new Promise((resolve) => setImmediate(resolve));

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors, []);
  return r;
}

function fakeLane(refusal) {
  const lane = { calls: [], pending: [] };
  lane.facade = Object.freeze({ complete(spec) {
    lane.calls.push(spec);
    if (refusal) return Promise.resolve({ ok: false, reason: refusal });
    const go = typeof spec.onAccepted === "function" ? spec.onAccepted() !== false : true;
    if (!go) return Promise.resolve({ ok: false, reason: "ABORTED" });
    return new Promise((resolve) => lane.pending.push((text) => resolve({ ok: true, text, tokens: 1, ms: 0 })));
  } });
  return lane;
}

function rigOf(opened, over) {
  const o = over || {};
  const journal = createJournal({ clock: { now: () => o.clock.now }, maxPayloadBytes: 4096, maxRows: 500 });
  const S = F.settingsOf({ enabled: true, aiEnabled: true, maxOpenThreads: 4, arcCooldownCycles: 0,
    systemCooldownCycles: 0, ...(o.settings || {}) });
  const { registry, sender } = F.registryWithBuiltins(S);
  if (o.hint) assert.ok(registry.registerHintSource({ key: "seasons", read: o.hint }).ok);
  const graph = F.graphFixture();
  const presence = { getStatus: () => ({ available: true, stale: false }), observedSystems: () => [30000001],
    getSystemPresence: () => ({ characters: [PLAYER] }) };
  const lines = [];
  const make = () => createGameMasterService({ store: opened.store, journal, worldSeed: 1, settings: S, registry,
    sender, getPresence: () => presence, getGraph: () => graph, readFactionNames: () => ({ ok: true, names: F.NAMES }),
    getChatterAi: () => (o.lane ? o.lane.facade : null), getNews: o.getNews || (() => null),
    logger: { log: (l) => lines.push(l) }, clockNow: () => o.clock.now });
  return { S, registry, graph, lines, make };
}

module.exports = ({ test, skip }) => {
  test("G10 lane plot: gates, onAccepted before the transport, PLOT_IN_FLIGHT / PLOT_BUDGET, talk and news unchanged; "
    + "filterPlotText / filterPlotField; W87", async () => {
    const on = (env) => configOf({ EVEJS_LNE_CHATTER_AI_ENABLED: "1", EVEJS_LNE_CHATTER_AI_API_KEY: KEY, ...env })
      .config;
    const rig = (config, flags) => {
      const calls = [];
      const lines = [];
      const r = startChatterAi({ config, clock: { now: () => T0 }, nowMs: () => T0, logger: { log: (l) => lines.push(l) },
        setTimer: () => ({ cancel() {}, hasRef: () => false }), buckets: [], getGovernor: () => null,
        transport: { post: (spec) => new Promise((resolve) => calls.push({ spec, resolve })) }, ...flags });
      assert.ok(r.ok, JSON.stringify(r));
      return { ai: r.chatterAi, calls, lines };
    };
    const msgs = [{ role: "system", content: "Game Master rules." }, { role: "user", content: "Places: P1." }];
    const spec = (over) => ({ lane: "plot", messages: msgs, minChars: 20, maxChars: 4000, ...(over || {}) });
    const answer = (text) => ({ ok: true, status: 200, json: { choices: [{ message: { content: text },
      finish_reason: "stop" }], usage: { total_tokens: 90 } } });

    const r = rig(on(), { plotEnabled: true });
    assert.strictEqual(r.ai.getStatus().state, "running", "plot alone keeps the service RUNNING");
    let seen = -1;
    const p = r.ai.complete(spec({ onAccepted: () => {
      seen = r.calls.length;
      return true;
    } }));
    assert.deepStrictEqual([seen, r.calls.length], [0, 1], "onAccepted before the request");
    const body = JSON.parse(r.calls[0].spec.body);
    assert.deepStrictEqual([body.max_tokens, body.messages, r.calls[0].spec.timeoutMs], [700, msgs, 90000]);
    assert.deepStrictEqual(await r.ai.complete(spec()), { ok: false, reason: "PLOT_IN_FLIGHT" });
    const json = "```json\n{\"v\":1,\"arc\":\"WAR_RUMOUR\"}\n```";
    r.calls[0].resolve(answer(json));
    assert.deepStrictEqual(await p, { ok: true, text: json, tokens: 90, ms: 0 });
    const st = r.ai.getStatus();
    assert.deepStrictEqual([st.byLane.plot, st.plotTokensToday, st.plotInFlight, st.counters.plotInFlightBlocked,
      st.byLane.news.requests, st.byLane.talk.requests], [{ requests: 1, linesAccepted: 1, tokens: 90 }, 90, 0, 1, 0, 0]);
    for (const bad of [spec({ messages: [{ role: "user", content: "x".repeat(8001) }] }), spec({ onAccepted: 1 }),
      spec({ minChars: 0 })]) {
      assert.deepStrictEqual(await r.ai.complete(bad), { ok: false, reason: "BAD_SPEC" });
    }
    assert.deepStrictEqual(await r.ai.complete(spec({ onAccepted: () => false })), { ok: false, reason: "ABORTED" });
    const short = r.ai.complete(spec());
    r.calls[1].resolve(answer("{}"));
    assert.deepStrictEqual(await short, { ok: false, reason: "REJECTED_LENGTH", tokens: 90 });
    assert.strictEqual(r.calls.length, 2, "BAD_SPEC / ABORTED without HTTP");
    assert.ok(!r.lines.join("\n").includes("Game Master rules") && !r.lines.join("\n").includes("WAR_RUMOUR"));
    r.ai.stop("test");

    const poor = rig(on({ EVEJS_LNE_CHATTER_AI_PLOT_TOKEN_SHARE_PERMILLE: "0" }), { plotEnabled: true });
    let called = false;
    assert.deepStrictEqual(await poor.ai.complete(spec({ onAccepted: () => {
      called = true;
    } })), { ok: false, reason: "PLOT_BUDGET" });
    assert.deepStrictEqual([poor.calls.length, called, poor.ai.getStatus().counters.plotBudgetExhausted], [0, false, 1]);
    poor.ai.stop("test");

    const none = rig(on(), {});
    assert.deepStrictEqual([none.ai.getStatus().state, none.ai.getStatus().lastError], ["disabled", "NO_BUCKETS"]);
    const news = rig(on(), { newsEnabled: true });
    news.ai.complete({ ...spec(), lane: "news" });
    const newsBody = JSON.parse(news.calls[0].spec.body);
    assert.deepStrictEqual([newsBody.max_tokens, news.calls[0].spec.timeoutMs, news.ai.getStatus().newsInFlight,
      news.ai.getStatus().plotInFlight], [1200, 60000, 1, 0]);
    news.ai.stop("test");

    assert.deepStrictEqual(filterPlotText("  x  ", { minChars: 2, maxChars: 10 }), { ok: false, reason: "LENGTH" });
    assert.deepStrictEqual(filterPlotText(" {\"v\":1} ", { minChars: 2, maxChars: 10 }), { ok: true, text: "{\"v\":1}" });
    const field = (t) => filterPlotField(t, { maxChars: 60 }, null).reason || "ok";
    assert.deepStrictEqual(["The mutineers hide near Ostu.", "!kick everyone", "See example.com now.", "Call 1234567",
      "{system} burns", "x".repeat(61)].map(field), ["ok", "COMMAND", "LINK", "DIGITS", "PLACEHOLDER", "LENGTH"]);

    const w87 = (env) => configOf({ EVEJS_LNE_GAMEMASTER_ENABLED: "1", EVEJS_LNE_NEWS_ENABLED: "1",
      EVEJS_LNE_NOTICES_ENABLED: "1", ...env }).warnings.filter((w) => w.startsWith("gameMaster.aiEnabled without")
      || w.startsWith("gameMaster.promptMaxChars="));
    assert.strictEqual(w87({ EVEJS_LNE_GAMEMASTER_AI_ENABLED: "1" }).length, 1);
    assert.strictEqual(w87({ EVEJS_LNE_GAMEMASTER_AI_ENABLED: "1", EVEJS_LNE_CHATTER_AI_ENABLED: "1",
      EVEJS_LNE_CHATTER_AI_PLOT_TOKEN_SHARE_PERMILLE: "0" }).length, 1);
    assert.strictEqual(w87({ EVEJS_LNE_GAMEMASTER_AI_ENABLED: "1", EVEJS_LNE_CHATTER_AI_ENABLED: "1",
      EVEJS_LNE_CHATTER_AI_PLOT_MAX_PROMPT_CHARS: "2000" }).length, 1);
    assert.deepStrictEqual([w87({}), w87({ EVEJS_LNE_GAMEMASTER_AI_ENABLED: "1", EVEJS_LNE_CHATTER_AI_ENABLED: "1" })],
      [[], []]);
  });

  test("G9 prompt: names and refs only (no ID, no player, no PLAYER_* / BOUNTY_* fact), fact place first, hints; "
    + "cut hints -> facts; the news stub -> no fact", () => {
    const S = F.settingsOf({ enabled: true, aiEnabled: true });
    const { registry } = F.registryWithBuiltins(S);
    assert.ok(registry.registerHintSource({ key: "seasons", read: () => ({ lines: [HINT, "x".repeat(161), 7],
      arcBias: ["WAR_RUMOUR", "MUTINY", "NOPE"] }) }).ok);
    assert.ok(registry.registerHintSource({ key: "bosses", read: () => {
      throw new Error("boom");
    } }).ok);
    const hints = readHints(registry);
    assert.deepStrictEqual(hints, [{ key: "seasons", lines: [HINT], arcBias: ["WAR_RUMOUR", "MUTINY"] }]);
    const facts = factsOf(FACTS, S);
    assert.deepStrictEqual(facts, { lines: [FACTS[2].text], systemIds: [30000011] });
    const graph = F.graphFixture();
    const offer = buildOffer({ cycleAt: T0 - HOUR, seed: 5, graph, factionNames: F.NAMES, activityRows: [
      { regionId: 10000001, samples: 30 }], recentThreads: [], registry, S, hints, factSystemIds: facts.systemIds })
      .offer;
    assert.strictEqual(offer.places[0].systemId, 30000011, "the fact system is P1");
    assert.deepStrictEqual(offer.arcBias, ["WAR_RUMOUR"], "only offered arcs");
    const prompt = buildPlotPrompt({ offer, factLines: facts.lines, regionName: (id) => graph.getRegionName(id) }, S);
    assert.ok(prompt.ok, JSON.stringify(prompt));
    const text = `${prompt.system}\n${prompt.user}`;
    assert.ok(text.length <= S.promptMaxChars);
    for (const want of ["P1 | Kor-Azor | Beta Drift | nullsec", "guristas | Guristas Pirates | pirate", FACTS[2].text,
      HINT, "Alpha Reach: high", "Preferred arcs: WAR_RUMOUR", "- WAR_RUMOUR: NEWS, NOTICE, WAIT"]) {
      assert.ok(text.includes(want), want);
    }
    for (const never of ["Evil Player Corp", "Hunter Bob", PLAYER.name, "PLAYER_", "BOUNTY_"]) {
      assert.ok(!text.includes(never), never);
    }
    assert.ok(!/\d{6,}/.test(text), "no ID in the prompt");
    const full = text.length + 1;
    const tight = buildPlotPrompt({ offer, factLines: facts.lines, regionName: (id) => graph.getRegionName(id) },
      { ...S, promptMaxChars: full - HINT.length - 2 });
    assert.deepStrictEqual([tight.ok, tight.cut.hints, tight.cut.facts], [true, 1, 0]);
    assert.deepStrictEqual(buildPlotPrompt({ offer, factLines: [], regionName: () => null }, { ...S,
      promptMaxChars: SYSTEM_PROMPT.length }), { ok: false, reason: "PROMPT_TOO_LARGE" });
    assert.deepStrictEqual(createUnavailableNews("NEWS_DISABLED").listRecentFacts({ since: 0, limit: 5 }),
      { ok: false, reason: "NEWS_DISABLED" });
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("G11 game master LLM road on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("G11 LLM road: ```json answer -> thread ai (attempts before the answer); junk -> NOT_JSON, retry after "
    + "aiRetryMs, then the template; DISABLED -> the template; no text in the log; listRecentFactsInTx", async () => {
    await withStoreAsync(driver, async (opened) => {
      const clock = { now: T0 };
      const lane = fakeLane(null);
      let newsAsked = 0;
      const getNews = () => ({ listRecentFacts: (o) => {
        newsAsked += 1;
        assert.ok(o.limit >= 1 && o.since >= 0);
        return newsAsked === 1 ? { ok: true, facts: FACTS } : createUnavailableNews("NEWS_DISABLED").listRecentFacts(o);
      } });
      const rig = rigOf(opened, { clock, lane, getNews, hint: () => ({ lines: [HINT] }) });
      const repo = createGameMasterRepository();
      const cycle = (at) => opened.store.transaction("g11.read", (tx) => repo.readCycleInTx(tx, at)).value;
      const thread = (at) => opened.store.transaction("g11.read", (tx) => repo.readThreadInTx(tx, `gmt:${at}`)).value;
      const svc = rig.make();
      assert.strictEqual(svc.runActivity(T0).regions, 1, "a player in presence (only a region count is kept)");
      const c = cycleAtOrBefore(T0, rig.S);

      assert.ok(svc.runPass(T0).ok);
      assert.strictEqual(lane.calls.length, 1);
      assert.deepStrictEqual([cycle(c).state, cycle(c).attempts], ["DRAFTING", 1], "the attempt before the answer");
      const user = lane.calls[0].messages[1].content;
      assert.ok(user.includes(HINT) && user.includes(FACTS[2].text) && !user.includes(PLAYER.name));
      const ref = /- (P\d+) \|/.exec(user)[1];
      const answer = { v: 1, arc: "WAR_RUMOUR", faction: "guristas", place: ref, title: "Whispers of war",
        hook: "Pilots speak of a Guristas Pirates fleet on the move.",
        steps: [{ t: "NEWS" }, { t: "NOTICE", text: "Scouts count more ships on the gates." }, { t: "WAIT", hours: 3 }],
        end: { won: "The fleet never came.", lost: "The rumour goes quiet." } };
      assert.ok(svc.runPass(T0 + 1000).ok);
      assert.strictEqual(lane.calls.length, 1, "one request in flight");
      lane.pending[0](`Here is the thread:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``);
      await flush();
      let t = thread(c);
      assert.ok(t, rig.lines.join("\n"));
      assert.deepStrictEqual([t.source, t.arc, t.plan.title, t.plan.textFallback, cycle(c).state],
        ["ai", "WAR_RUMOUR", "Whispers of war", [], "STARTED"]);
      let counters = svc.getStatus().counters;
      assert.deepStrictEqual([counters["ai.requested"], counters["ai.accepted"], counters["threads.started.ai"]],
        [1, 1, 1]);

      const c2 = c + 24 * HOUR;
      clock.now = c2 + 11 * 60000;
      assert.ok(svc.runPass(clock.now).ok);
      assert.strictEqual(lane.calls.length, 2);
      assert.ok(!lane.calls[1].messages[1].content.includes("News of the last days"), "NEWS_DISABLED -> no fact");
      lane.pending[1]("ZZJUNK no json in this answer at all");
      await flush();
      assert.deepStrictEqual([cycle(c2).state, cycle(c2).attempts, cycle(c2).reason], ["DRAFTING", 1, "NOT_JSON"]);
      const again = rig.make();
      clock.now += 60000;
      assert.ok(again.runPass(clock.now).ok);
      assert.ok(svc.runPass(clock.now).ok);
      assert.strictEqual(lane.calls.length, 2, "no attempt before aiRetryMs (also after a restart)");
      clock.now += rig.S.aiRetryMs;
      assert.ok(again.runPass(clock.now).ok);
      assert.strictEqual(lane.calls.length, 3);
      lane.pending[2]("ZZJUNK still no json in this answer");
      await flush();
      assert.ok(again.runPass(clock.now + 1000).ok);
      t = thread(c2);
      assert.deepStrictEqual([t.source, cycle(c2).state, cycle(c2).attempts], ["template", "STARTED", 2]);
      assert.strictEqual(lane.calls.length, 3, "attempts spent: no third request");
      assert.deepStrictEqual([svc.getStatus().counters["rejected.NOT_JSON"], again.getStatus().counters[
        "rejected.NOT_JSON"], again.getStatus().counters["threads.started.template"]], [1, 1, 1]);

      const c3 = c2 + 24 * HOUR;
      clock.now = c3 + 11 * 60000;
      const off = rigOf(opened, { clock, lane: fakeLane("DISABLED") });
      const svc3 = off.make();
      assert.ok(svc3.runPass(clock.now).ok);
      await flush();
      assert.strictEqual(svc3.getStatus().counters["ai.refused.DISABLED"], 1);
      assert.ok(svc3.runPass(clock.now + 1000).ok);
      assert.deepStrictEqual([thread(c3).source, cycle(c3).attempts], ["template", 0]);

      const log = [...rig.lines, ...off.lines].join("\n");
      for (const never of ["ZZJUNK", "Whispers", "Guristas Pirates fleet", SYSTEM_PROMPT.slice(0, 30), "Places (ref",
        HINT]) {
        assert.ok(!log.includes(never), never);
      }
      assert.ok(log.includes("plot answer refused NOT_JSON") && log.includes("source=ai"), log);
    });

    withStore(driver, (opened) => {
      const repo = createNewsRepository({});
      const fact = (key, at, weight) => ({ factKey: key, kind: "BATTLE", at, systemId: 30000011, weight,
        data: { systemName: "Kor-Azor" } });
      const r = opened.store.transaction("g11.news", (tx) => {
        const up = repo.upsertFactsInTx(tx, [fact("a", 100, 5), fact("b", 200, 9), fact("c", 50, 99)], 300);
        assert.ok(up.ok, JSON.stringify(up));
        return repo.listRecentFactsInTx(tx, { since: 100, limit: 5 });
      });
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual(r.value.facts.map((f) => f.factKey), ["b", "a"]);
    });
  });
};
