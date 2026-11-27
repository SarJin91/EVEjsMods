"use strict";

const assert = require("node:assert");

const { harness: H } = require("./service.test");
const { lineGraph, regionOf, fakeSites, fakePresence } = require("./fixture");
const { withStoreAsync } = require("../notices/storeHelper");
const { buildLorePrompt, filterLore, loreReasonOf, LORE_REASONS } = require("../../lib/archaeology/lore");
const S = require("../../lib/archaeology/schema");

const ARCHIVE = "container:lne_archive";
const AI_TEXT = "Beneath the dust of a dead relay the old voices still argue about a sky that no longer exists.";
const THREE = { EVEJS_LNE_ARCHAEOLOGY_STAGE_COUNT_MIN: "3", EVEJS_LNE_ARCHAEOLOGY_STAGE_COUNT_MAX: "3" };
const LORE_ON = { ...THREE, EVEJS_LNE_ARCHAEOLOGY_LORE_AI_ENABLED: "1" };
const eventOf = (c) => `${c.chain_id}:s${c.stage_no}:r${c.stage_spawn_no}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function stubAi(r) {
  const s = { calls: [], resolvers: [], seen: [], state: "running",
    getStatus: () => ({ state: s.state }),
    complete(spec) {
      s.calls.push(spec);
      if (r.current) s.seen.push(r.current.q("SELECT lore_attempts FROM world_arch_fragments").map((x) => x.lore_attempts));
      return new Promise((resolve) => s.resolvers.push(resolve));
    } };
  return s;
}

function toFound(r, P, presence, wins, chars) {
  for (const characterId of chars) r.emit(H.hackWin({ characterId }));
  let t = H.T0;
  r.a.runPass(t);
  for (const c of H.chains(r)) presence.where.set(c.character_id, c.stage_system_id);
  t += P.presenceCheckMs;
  r.a.runPass(t);
  for (const c of H.chains(r)) {
    wins.set(`lne:${eventOf(c)}:0`, { ok: true, state: "active",
      wins: [{ contentKey: ARCHIVE, characterId: c.character_id, outcomeId: `o-${c.character_id}`, atMs: 1 }] });
    r.emit(H.hackWin({ own: true, lneEventId: eventOf(c) }));
  }
  r.a.runPass(t + 1);
  assert.ok(H.chains(r).every((c) => c.stage_state === "FOUND"));
  return t + 1;
}

const frags = (r) => r.q("SELECT * FROM world_arch_fragments ORDER BY chain_id, stage_no");
const loreMails = (r) => r.q("SELECT * FROM world_notice_items WHERE kind = 'ARCH_LORE' ORDER BY event_key");

function setup(opened, env, chars = [H.C1]) {
  const conf = H.cfg(env);
  const presence = fakePresence();
  const wins = new Map();
  const holder = { current: null };
  const ai = stubAi(holder);
  const r = H.rig(opened, conf, { presence, wins, sites: fakeSites(), chatterAi: ai });
  holder.current = r;
  const t = toFound(r, conf.archaeology, presence, wins, chars);
  return { conf, P: conf.archaeology, presence, wins, ai, r, t, holder };
}

module.exports = ({ test, skip }) => {
  test("A13a archaeology lore pure: no player / system data in the prompt, stage in words + region; filterLore "
    + "DIGITS / URL / MARKUP / LENGTH; loreReasonOf REJECTED_X = FILTER, ??? = OTHER", () => {
    const graph = lineGraph();
    const systemId = 107;
    const regionName = graph.getRegionName(regionOf(systemId));
    const input = { theme: "JOVE", stageNo: 3, stageCount: 5, regionName, analyzer: "data", language: "en",
      maxLoreChars: 300, characterId: H.C1, characterName: "Testpilot Alpha", systemId, systemName: `Sys-${systemId}` };
    const p = buildLorePrompt(input);
    assert.strictEqual(p.ok, true);
    const all = p.messages.map((m) => m.content).join("\n");
    for (const banned of [String(H.C1), "Testpilot Alpha", `Sys-${systemId}`, String(systemId)]) {
      assert.ok(!all.includes(banned), banned);
    }
    assert.ok(all.includes("third of five") && all.includes(`Region: ${regionName}`) && all.includes("data archive"),
      all);
    const pl = buildLorePrompt({ ...input, language: "pl", regionName: null });
    assert.ok(pl.ok && pl.messages[0].content.endsWith("Write in Polish.") && pl.messages[1].content
      .includes("Region: unknown"), JSON.stringify(pl));
    assert.deepStrictEqual(buildLorePrompt({ ...input, stageNo: 9 }), { ok: false, reason: "INVALID_INPUT" });
    const o = { maxLoreChars: 300 };
    assert.deepStrictEqual(filterLore(`${AI_TEXT} Year 3`, o), { ok: false, reason: "DIGITS" });
    assert.deepStrictEqual(filterLore(`${AI_TEXT} http://example.org`, o), { ok: false, reason: "URL" });
    assert.deepStrictEqual(filterLore(`${AI_TEXT} {x}`, o), { ok: false, reason: "MARKUP" });
    assert.deepStrictEqual(filterLore("Twenty chars of lore", o), { ok: false, reason: "LENGTH" });
    assert.deepStrictEqual(filterLore(`  ${AI_TEXT}  \nsecond line`, o), { ok: true, text: AI_TEXT });
    assert.deepStrictEqual([loreReasonOf("REJECTED_X"), loreReasonOf("???"), loreReasonOf("TALK_BUDGET")],
      ["FILTER", "OTHER", "TALK_BUDGET"]);
    for (const reason of LORE_REASONS) assert.ok(S.COUNTER_NAMES.includes(`lore.refused.${reason}`), reason);
  });

  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("A13b-e archaeology lore pump", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("A13b archaeology lore happy path: LORE_ASK (attempts 1 before complete, 1 call) -> answer -> next pass "
    + "delivers the AI text, lore_source ai, lore.ai.delivered; no text / prompt in the log",
  () => withStoreAsync(driver, async (opened) => {
    const { ai, r, t, P } = setup(opened, LORE_ON);
    const c0 = H.chains(r)[0];
    r.a.runPass(t + 1);
    assert.deepStrictEqual([ai.calls.length, ai.seen], [1, [[1]]]);
    let c = H.chains(r)[0];
    assert.deepStrictEqual([c.stage_no, c.stage_state, c.next_check_at], [1, "FOUND", t + 1 + P.loreWaitMs]);
    const spec = ai.calls[0];
    assert.deepStrictEqual([spec.lane, spec.key, spec.minChars, spec.maxChars, spec.names],
      ["talk", `arch:${c0.theme.toLowerCase()}`, 40, P.maxLoreChars, []]);
    const prompt = spec.messages.map((m) => m.content).join("\n");
    for (const banned of [String(H.C1), `Sys-${c0.stage_system_id}`, String(c0.stage_system_id), c0.chain_id]) {
      assert.ok(!prompt.includes(banned), banned);
    }
    assert.ok(prompt.includes("first of three"), prompt);
    ai.resolvers[0]({ ok: true, line: AI_TEXT, tokens: 50, ms: 10 });
    await flush();
    assert.deepStrictEqual(frags(r).map((f) => [f.lore_source, f.lore_attempts, f.delivered_at]), [["ai", 1, null]]);
    r.a.runPass(t + 2);
    c = H.chains(r)[0];
    assert.deepStrictEqual([c.stage_no, c.stage_state], [2, "REVEALED"]);
    const f = frags(r)[0];
    assert.deepStrictEqual([f.lore_source, f.lore_attempts, f.delivered_at], ["ai", 1, t + 2]);
    const mails = loreMails(r);
    assert.strictEqual(mails.length, 1);
    assert.ok(mails[0].line.endsWith(`: ${AI_TEXT}`), mails[0].line);
    const st = r.a.getStatus().counters;
    assert.deepStrictEqual([st["lore.asked"], st["lore.ai"], st["lore.ai.delivered"], st["lore.template"],
      st.errors, ai.calls.length], [1, 1, 1, 0, 0, 1]);
    const log = r.logger.lines.join("\n");
    assert.ok(!log.includes(AI_TEXT.slice(0, 20)), log);
    for (const m of spec.messages) assert.ok(!log.includes(m.content.slice(0, 30)), log);
    r.a.stop();
  }));

  test("A13c archaeology lore refusal: TALK_BUDGET -> the template in the next pass (no loreWaitMs wait), "
    + "lore.refused.TALK_BUDGET", () => withStoreAsync(driver, async (opened) => {
    const { ai, r, t } = setup(opened, LORE_ON);
    r.a.runPass(t + 1);
    ai.resolvers[0]({ ok: false, reason: "TALK_BUDGET" });
    await flush();
    r.a.runPass(t + 2);
    const f = frags(r)[0];
    assert.deepStrictEqual([f.lore_source, f.lore_attempts, f.delivered_at], ["template", 1, t + 2]);
    assert.strictEqual(loreMails(r).length, 1);
    const st = r.a.getStatus().counters;
    assert.deepStrictEqual([st["lore.refused.TALK_BUDGET"], st["lore.template"], st["lore.ai"], ai.calls.length],
      [1, 1, 0, 1]);
    r.a.stop();
  }));

  test("A13d archaeology lore restart: after LORE_ASK a new service -> SKIP before next_check_at, then the template; "
    + "1 complete in total; the late answer = lore.late, mail unchanged", () => withStoreAsync(driver, async (opened) => {
    const { ai, r, t, P, presence, wins } = setup(opened, LORE_ON);
    r.a.runPass(t + 1);
    assert.strictEqual(ai.calls.length, 1);
    r.a.stop();
    const holder2 = { current: null };
    const ai2 = stubAi(holder2);
    const r2 = H.rig(opened, H.cfg(LORE_ON), { presence, wins, sites: fakeSites(), chatterAi: ai2 });
    holder2.current = r2;
    r2.emit(H.hackWin({ own: true, lneEventId: eventOf(H.chains(r2)[0]) }));
    assert.strictEqual(r2.a.runPass(t + 2).steps, 0);
    assert.deepStrictEqual([H.chains(r2)[0].stage_state, frags(r2)[0].delivered_at, ai2.calls.length],
      ["FOUND", null, 0]);
    r2.a.runPass(t + 1 + P.loreWaitMs);
    const f = frags(r2)[0];
    assert.deepStrictEqual([f.lore_source, f.lore_attempts, f.delivered_at], ["template", 1, t + 1 + P.loreWaitMs]);
    const before = loreMails(r2).map((m) => m.line);
    ai.resolvers[0]({ ok: true, line: AI_TEXT });
    await flush();
    assert.deepStrictEqual([ai.calls.length + ai2.calls.length, r.a.getStatus().counters["lore.late"]], [1, 1]);
    assert.deepStrictEqual(loreMails(r2).map((m) => m.line), before);
    assert.strictEqual(frags(r2)[0].lore_source, "template");
    r2.a.stop();
  }));

  test("A13e archaeology lore day limit 1, two chains -> one request, the other the template + lore.dayLimit; "
    + "the flag off -> 0 calls, the template", () => withStoreAsync(driver, async (opened) => {
    const { ai, r, t } = setup(opened, { ...LORE_ON, EVEJS_LNE_ARCHAEOLOGY_MAX_LORE_REQUESTS_PER_DAY: "1" },
      [H.C1, H.C2]);
    r.a.runPass(t + 1);
    assert.strictEqual(ai.calls.length, 1);
    assert.deepStrictEqual(frags(r).map((f) => [f.lore_source, f.lore_attempts]).sort(),
      [["pending", 1], ["template", 0]]);
    const st = r.a.getStatus().counters;
    assert.deepStrictEqual([st["lore.asked"], st["lore.dayLimit"], st["lore.template"]], [1, 1, 1]);
    r.a.stop();
    await flush();
  }).then(() => withStoreAsync(driver, async (opened) => {
    const { ai, r, t } = setup(opened, THREE);
    r.a.runPass(t + 1);
    assert.deepStrictEqual([ai.calls.length, frags(r)[0].lore_source, loreMails(r).length], [0, "template", 1]);
    assert.strictEqual(r.a.getStatus().counters["lore.asked"], 0);
    r.a.stop();
  })));
};
