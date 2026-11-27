"use strict";

const assert = require("node:assert");

const { harness: H } = require("./service.test");
const { fakeSites, fakePresence } = require("./fixture");
const { parseRewardCsv, validateReward, rewardOfJson } = require("../../lib/archaeology/reward");
const { archiveSpecOf } = require("../../lib/archaeology/content");

const ARCHIVE = "container:lne_archive";
const winOf = (characterId, outcomeId) => ({ ok: true, state: "active",
  wins: [{ contentKey: ARCHIVE, characterId, outcomeId, atMs: 1 }] });
const TWO_STAGES = { EVEJS_LNE_ARCHAEOLOGY_STAGE_COUNT_MIN: "2", EVEJS_LNE_ARCHAEOLOGY_STAGE_COUNT_MAX: "2" };

module.exports = ({ test, skip }) => {
  test("A10a archaeology reward: parseRewardCsv (runs, > 4, format, duplicate, empty), validateReward missing, "
    + "rewardOfJson", () => {
    assert.deepStrictEqual(parseRewardCsv("341601:1:3,341604:1"), { ok: true,
      entries: [{ typeId: 341601, quantity: 1, runs: 3 }, { typeId: 341604, quantity: 1 }] });
    assert.deepStrictEqual(parseRewardCsv(""), { ok: true, entries: [] });
    for (const bad of ["1:1,2:1,3:1,4:1,5:1", "341601", "341601:0", "341601:1:101", "0:1", "1:1,1:2", "a:1"]) {
      assert.strictEqual(parseRewardCsv(bad).reason, "BAD_REWARD", bad);
    }
    const entries = parseRewardCsv("341601:1:3,341604:1").entries;
    assert.deepStrictEqual(validateReward(entries, new Map([[341601, {}]])),
      { entries: [{ typeId: 341601, quantity: 1, runs: 3 }], missing: [341604] });
    assert.deepStrictEqual(rewardOfJson("[{\"typeId\":5,\"quantity\":2}]"), [{ typeId: 5, quantity: 2 }]);
    for (const v of [null, "", "{", "[{\"typeId\":0,\"quantity\":1}]", "{\"a\":1}"]) assert.strictEqual(rewardOfJson(v), null);
  });

  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("A10 archaeology reward store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  const chainOf = (r) => H.chains(r)[0];
  const mails = (r) => r.q("SELECT event_key FROM world_notice_items ORDER BY item_id").map((m) => m.event_key);
  const eventOf = (c) => `${c.chain_id}:s${c.stage_no}:r${c.stage_spawn_no}`;

  test("A10 archaeology reward: refused facts -> RESCHEDULE readRefused; frozen with a missing type; explicitLoot of "
    + "the last archive with runs; config change after the freeze no effect; last archive stolen -> STOLEN + one mail",
  () => H.withStore(driver, (opened) => {
    const conf = H.cfg(TWO_STAGES);
    const P = conf.archaeology;
    const presence = fakePresence();
    const sites = fakeSites();
    const wins = new Map();
    let refuse = true;
    const readItemTypeFacts = (ids) => (refuse ? { ok: false, reason: "ITEM_TYPES_UNAVAILABLE" } : { ok: true,
      facts: new Map(ids.filter((id) => id < 341604).map((id) => [id, { typeId: id }])),
      missing: ids.filter((id) => id >= 341604) });
    const r = H.rig(opened, conf, { presence, sites, wins, readItemTypeFacts });
    r.emit(H.hackWin());
    let t = H.T0;
    r.a.runPass(t);
    let c = chainOf(r);
    presence.where.set(H.C1, c.stage_system_id);
    t += P.presenceCheckMs;
    r.a.runPass(t);
    c = chainOf(r);
    wins.set(`lne:${eventOf(c)}:0`, winOf(H.C1, "o-1"));
    r.emit(H.hackWin({ own: true, lneEventId: eventOf(c) }));
    r.a.runPass(t + 1);
    assert.strictEqual(chainOf(r).stage_state, "FOUND");
    r.a.runPass(t + 2);
    c = chainOf(r);
    assert.deepStrictEqual([c.stage_no, c.stage_state, c.reward_json, c.next_check_at], [1, "FOUND", null,
      t + 2 + P.retryMs]);
    assert.strictEqual(r.a.getStatus().counters["reward.readRefused"], 1);
    refuse = false;
    t = t + 2 + P.retryMs;
    r.a.runPass(t);
    c = chainOf(r);
    const bp = c.theme === "JOVE" ? 341601 : 341603;
    assert.deepStrictEqual([c.stage_no, c.stage_state, JSON.parse(c.reward_json)], [2, "REVEALED",
      [{ typeId: bp, quantity: 1, runs: 3 }]]);
    let st = r.a.getStatus().counters;
    assert.deepStrictEqual([st["reward.frozen"], st["reward.typeMissing"], st.errors], [1, 1, 0]);
    const loot = (provider) => provider.build(`${c.chain_id}:s2:r0`, 0).containers.map((x) => x.explicitLoot);
    assert.deepStrictEqual(loot(sites.calls.providers[0]), [[{ typeId: bp, quantity: 1, runs: 3 }]]);
    const conf2 = H.cfg({ ...TWO_STAGES, EVEJS_LNE_ARCHAEOLOGY_FINAL_REWARD_JOVE_CSV: "34:5",
      EVEJS_LNE_ARCHAEOLOGY_FINAL_REWARD_DRIFTER_CSV: "34:5" });
    const r2 = H.rig(opened, conf2, { presence, sites, wins });
    assert.deepStrictEqual(loot(sites.calls.providers.at(-1)), [[{ typeId: bp, quantity: 1, runs: 3 }]]);
    r2.a.stop();
    assert.deepStrictEqual(archiveSpecOf({ theme: c.theme, stageNo: 2, stageCount: 2, reward: null }, P).explicitLoot,
      []);
    assert.deepStrictEqual(archiveSpecOf({ theme: c.theme, stageNo: 1, stageCount: 2,
      reward: [{ typeId: bp, quantity: 1 }] }, P).explicitLoot, [], "only the last archive");

    presence.where.set(H.C1, c.stage_system_id);
    t += 10;
    r.a.runPass(t);
    c = chainOf(r);
    assert.strictEqual(c.stage_state, "SITE_PENDING");
    const cleanups = sites.calls.cleanup.length;
    wins.set(`lne:${eventOf(c)}:0`, winOf(H.C2, "o-thief"));
    t += P.sitePollMs;
    r.a.runPass(t);
    r.a.runPass(t + P.sitePollMs);
    c = chainOf(r);
    assert.deepStrictEqual([c.state, c.end_reason], ["STOLEN", "STOLEN"]);
    assert.deepStrictEqual(mails(r).filter((k) => k.startsWith("arch:stolen:")), [`arch:stolen:${c.chain_id}`]);
    assert.ok(!mails(r).some((k) => k.startsWith(`arch:hint:${c.chain_id}:2:m`)), "no relocation");
    assert.strictEqual(sites.calls.cleanup.length, cleanups, "no cleanup: the thief keeps the loot");
    assert.deepStrictEqual(sites.calls.providers[0].build(eventOf(c), 0).containers, []);
    st = r.a.getStatus().counters;
    assert.deepStrictEqual([st["chains.ended.STOLEN"], st["stages.stolen"], st["reward.frozen"], st.errors],
      [1, 1, 1, 0]);
    r.a.stop();
  }));
};
