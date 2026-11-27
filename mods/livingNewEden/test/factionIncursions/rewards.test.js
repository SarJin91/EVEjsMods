"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const W = require("../../lib/heavyEvents/world/schema");
const PS = require("../../lib/heavyEvents/payoutSchema");
const FS = require("../../lib/factionIncursions/schema");
const { ROLES: PLACEMENT_ROLES } = require("../../lib/factionIncursions/placement");
const { FACTIONS } = require("../../lib/factionIncursions/data/catalog");
const { ROLES, parseLpPerRole, roleOfIncursionEventId } = require("../../lib/heavyEvents/incursion/rewards");
const { incursionRewardsOf } = require("../../lib/heavyEvents");
const { createLive } = require("../../lib/heavyEvents/live");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { T0, CHAR, DEFENDER, harness, boot, cfg } = require("./harness");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const TOK = T0.toString(36);
const ON = Object.freeze({ EVEJS_LNE_FACTION_INCURSIONS_INFLUENCE_HQ_UNLOCK_MILLI: "600",
  EVEJS_LNE_FACTION_INCURSIONS_REWARDS_ENABLED: "1" });
const DEFAULT_LP = "staging:1000,vanguard:2000,assault:3000,hq:5000";
const NO_LP_FACTION = 500021;

function toDefeated(h, svc) {
  assert.strictEqual(svc.runPass(T0).created, 1, JSON.stringify(h.lines));
  svc.runPass(T0);
  h.clearSite(FS.siteEventIdOf(1, T0, "hq", 1), T0 + 1000, true);
  return 1;
}

function sideRows(h) {
  h.run((tx) => {
    for (const [eventId, ids] of [[`hin:1:${TOK}:staging:0`, [7, 8]], [`hin:1:${TOK}:hq:0`, [8, 9]],
      [`hin:2:${TOK}:hq:0`, [10]], [`hin:12:${TOK}:hq:0`, [11]]]) {
      assert.ok(h.payouts.planPayoutsInTx(tx, { eventId, issuerFactionId: DEFENDER, systemId: 30000001,
        characterIds: ids, iskAmount: 0, lpAmount: 0, standingMicro: 0, at: T0 }).ok);
    }
  });
}

const poolRows = (h, id = 1) => h.run((tx) => tx.prepare("SELECT payout_key, character_id, issuer_faction_id, "
  + "lp_amount, isk_amount, standing_micro FROM world_heavy_event_payouts WHERE event_id = ? ORDER BY character_id")
  .all(`finc:reward:${id}:${TOK}`)).map((r) => [r.payout_key, Number(r.character_id), Number(r.issuer_faction_id),
  Number(r.lp_amount), Number(r.isk_amount), Number(r.standing_micro)]);

module.exports = ({ test, skip }) => {
  test("FI17 LP per role of the hin: sites, without the flag, parseLpPerRole, defaults, W249", () => {
    const c = cfg();
    const R = incursionRewardsOf(cfg(ON).factionIncursions.rewards);
    assert.deepStrictEqual(R, { lpPerRole: { hq: 5000, assault: 3000, vanguard: 2000, staging: 1000 },
      standingMicro: 50000 });
    assert.strictEqual(incursionRewardsOf(c.factionIncursions.rewards), null, "flag off = null");
    const base = { settings: c.heavyEvents, power: c.powerSites, world: c.eventAnomalies };
    const hooks = { bump() {}, refuse() {} };
    const on = createLive({ ...base, incursionRewards: R }, hooks);
    const off = createLive(base, hooks);
    const row = (eventId, variant, tier) => ({ eventId, eventType: "trail", variant, tier });
    assert.deepStrictEqual(on.payoutAmountsOf(row("hin:1:t:hq:0", "breach", 3)),
      { iskAmount: 0, lpAmount: 5000, standingMicro: 50000, description: PS.WORLD_DESCRIPTION });
    assert.strictEqual(on.payoutAmountsOf(row("hin:1:t:staging:2", "staging", 1)).lpAmount, 1000);
    assert.strictEqual(on.payoutAmountsOf(row("hin:1:t:assault.1:0", "staging", 2)).lpAmount, 3000);
    assert.strictEqual(on.payoutAmountsOf(row("hin:1:t:nope:0", "staging", 1)).lpAmount, 0, "unknown role = 0");
    const stagingLp = W.parseLpPerTier(c.eventAnomalies[W.KIND_LP_KEY.staging])[0];
    const sub1 = off.payoutAmountsOf(row("hin:1:t:staging:2", "staging", 1));
    assert.deepStrictEqual([sub1.lpAmount, sub1.standingMicro],
      [stagingLp, c.eventAnomalies[W.KIND_STANDING_KEY.staging]], "flag off: the world keys");
    assert.deepStrictEqual(off.payoutAmountsOf(row("hin:1:t:hq:0", "breach", 3)),
      { iskAmount: 0, lpAmount: 0, standingMicro: 0, description: PS.WORLD_DESCRIPTION }, "breach: 0");

    assert.deepStrictEqual(parseLpPerRole("hq:7"), { hq: 7, assault: 0, vanguard: 0, staging: 0 });
    for (const bad of ["boss:1", "hq:1,hq:2", "hq:1000001", "hq:-1", "hq:1.5", "", "hq:1,", "hq"]) {
      assert.strictEqual(parseLpPerRole(bad), null, bad);
    }
    const rows = config.SCHEMA.filter((r) => r.key.startsWith("factionIncursions.rewards."));
    assert.deepStrictEqual(rows.map((r) => [r.key.slice(26), r.default, r.min, r.max]), [
      ["enabled", false, undefined, undefined], ["lpPerRole", DEFAULT_LP, undefined, undefined],
      ["siteStandingMicro", 50000, 0, 100000], ["hqPoolLp", 5000, 0, 1000000], ["maxPoolParticipants", 64, 1, 256],
      ["poolMaxHoldPasses", 120, 1, 100000]]);
    const warn = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } })
      .warnings.filter((w) => w.includes("W249"));
    assert.strictEqual(warn({ EVEJS_LNE_FACTION_INCURSIONS_REWARDS_ENABLED: "1",
      EVEJS_LNE_HEAVY_EVENTS_PAYOUT_ENABLED: "0" }).length, 1);
    assert.strictEqual(warn({ EVEJS_LNE_FACTION_INCURSIONS_REWARDS_ENABLED: "1" }).length, 0);
  });

  test("FI19 catalogue stage key = role, ROLES = placement ROLES, roleOfIncursionEventId of every slot", () => {
    assert.deepStrictEqual([...ROLES].sort(), [...PLACEMENT_ROLES].sort());
    for (const [factionId, f] of Object.entries(FACTIONS)) {
      for (const st of f.stages) {
        assert.strictEqual(st.key, st.role, `${factionId} ${st.key}`);
        for (const slots of [st.slots, 3]) {
          for (let i = 0; i < slots; i += 1) {
            const id = FS.siteEventIdOf(7, T0, FS.slotKeyOf(st.key, i, slots), 2);
            assert.strictEqual(roleOfIncursionEventId(id), st.role, id);
          }
        }
      }
    }
    assert.strictEqual(roleOfIncursionEventId("hin:9:hq:1"), null, "not the 5-part site id");
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("FI18 FI20 faction incursion rewards", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("FI18 HQ pool: participants of all sites, issuer = beneficiary, replay = duplicate, expired none, limit", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const settleRows = [];
      h.ctx.persistence = { ...h.ctx.persistence, store: { ...store, transaction: (name, fn) => {
        const r = store.transaction(name, fn);
        if (name === "factionIncursions.settle") settleRows.push(r.rows);
        return r;
      } } };
      const svc = boot(h, ON);
      assert.strictEqual(svc.getStatus().rewards, "on");
      toDefeated(h, svc);
      sideRows(h);
      const p = svc.runPass(T0 + 2000);
      assert.deepStrictEqual([p.decided, p.settled], [1, 1], JSON.stringify({ p, lines: h.lines }));
      const ids = [7, 8, 9, CHAR];
      assert.deepStrictEqual(poolRows(h), ids.map((id) => [`finc:reward:1:${TOK}:${id}`, id, DEFENDER, 5000, 0, 0]));
      assert.strictEqual(h.incursion(1).effect, "REPEL_APPLIED");
      assert.strictEqual(svc.getStatus().counters.rewardPoolPlanned, 4);
      assert.ok(settleRows[0] - ids.length <= FS.POOL_ROWS_RESERVE, `settle rows ${settleRows[0]}`);
      h.run((tx) => tx.prepare("UPDATE world_faction_incursions SET state = 'DECIDED', effect = NULL, "
        + "settled_at = NULL WHERE incursion_id = 1").run());
      assert.strictEqual(svc.runPass(T0 + 3000).settled, 0);
      assert.strictEqual(poolRows(h).length, 4);
      assert.strictEqual(svc.getStatus().counters.rewardPoolPlanned, 4);
      svc.stop();
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const svc = boot(h, ON);
      assert.strictEqual(svc.runPass(T0).created, 1);
      svc.runPass(T0);
      sideRows(h);
      const expiresAt = Number(h.run((tx) => tx.prepare(
        "SELECT expires_at AS t FROM world_faction_incursions WHERE incursion_id = 1").get().t));
      svc.runPass(expiresAt + 5000);
      assert.deepStrictEqual([h.incursion(1).outcome, h.incursion(1).effect], ["expired", "RECORDED"]);
      assert.deepStrictEqual(poolRows(h), [], "expired: no pool");
      svc.stop();
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const svc = boot(h, { ...ON, EVEJS_LNE_FACTION_INCURSIONS_REWARDS_MAX_POOL_PARTICIPANTS: "2" });
      toDefeated(h, svc);
      sideRows(h);
      svc.runPass(T0 + 2000);
      assert.deepStrictEqual(poolRows(h).map((r) => r[1]), [7, 8]);
      svc.stop();
    });
  });

  test("FI20 NO_LP_CORPORATION, HEAVY_EVENTS_UNAVAILABLE retry, heavy not ready waits, ROW_BOUND", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      h.claims[0].controllerFactionId = NO_LP_FACTION;
      const svc = boot(h, ON);
      toDefeated(h, svc);
      svc.runPass(T0 + 2000);
      assert.deepStrictEqual([h.incursion(1).state, h.incursion(1).effect], ["SETTLED", "REPEL_APPLIED"]);
      assert.deepStrictEqual(poolRows(h), []);
      assert.strictEqual(svc.getStatus().counters.rewardPoolSkipped, 1);
      assert.ok(h.lines.includes("factionIncursions: rewards pool skipped NO_LP_CORPORATION"), h.lines.join("\n"));
      svc.stop();
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const svc = boot(h, ON);
      toDefeated(h, svc);
      const real = h.ctx.heavyEvents;
      h.ctx.heavyEvents = { ...real,
        incursionParticipantsInTx: () => ({ ok: false, reason: "HEAVY_EVENTS_UNAVAILABLE" }) };
      svc.runPass(T0 + 2000);
      assert.deepStrictEqual([h.incursion(1).state, Number(h.incursion(1).attempts)], ["DECIDED", 1]);
      assert.deepStrictEqual(poolRows(h), []);
      h.ctx.heavyEvents = { ...real, getStatus: () => ({ state: "drain" }) };
      const before = h.lines.length;
      svc.runPass(T0 + 3000);
      svc.runPass(T0 + 4000);
      const fresh = h.lines.slice(before).filter((l) => l.includes("retry"));
      assert.deepStrictEqual(fresh, ["factionIncursions: settle retry HEAVY_EVENTS_UNAVAILABLE"]);
      assert.deepStrictEqual([h.incursion(1).state, Number(h.incursion(1).attempts)], ["DECIDED", 1]);
      assert.strictEqual(svc.getStatus().counters.settleRetry, 3);
      h.ctx.heavyEvents = real;
      svc.runPass(T0 + 5000);
      assert.strictEqual(h.incursion(1).state, "SETTLED");
      assert.deepStrictEqual(poolRows(h).map((r) => r[1]), [CHAR]);
      svc.stop();
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      h.ctx.persistence = { ...h.ctx.persistence, store: { ...store, limits: { ...store.limits,
        maxRowsPerTransaction: 40 } } };
      const svc = boot(h, ON);
      assert.strictEqual(svc.getStatus().rewards, "ROW_BOUND");
      assert.ok(h.lines.some((l) => l.includes("rewards pool off - ROW_BOUND 80 > persistence.maxRowsPerTransaction 40")),
        h.lines.join("\n"));
      toDefeated(h, svc);
      svc.runPass(T0 + 2000);
      assert.deepStrictEqual([h.incursion(1).state, h.incursion(1).effect], ["SETTLED", "REPEL_APPLIED"]);
      assert.deepStrictEqual(poolRows(h), []);
      assert.strictEqual(svc.getStatus().counters.rewardPoolPlanned, 0);
      svc.stop();
    });
  });

  test("FI21 heavy not ready: expired behind 5 waiting defeated settles, poolMaxHoldPasses, INVALID_INPUT final", () => {
    const NOT_READY = (real) => ({ ...real, getStatus: () => ({ state: "drain" }) });
    const copy = (h, id, outcome) => h.run((tx) => {
      const src = tx.prepare("SELECT * FROM world_faction_incursions WHERE incursion_id = 1").get();
      const row = { ...src, incursion_id: id, idempotency_key: `copy:${id}`,
        constellation_id: Number(src.constellation_id) + id, state: "DECIDED", outcome,
        hq_event_id: outcome === "defeated" ? src.hq_event_id : null, attempts: 0, version: 1 };
      const cols = Object.keys(row);
      tx.prepare(`INSERT INTO world_faction_incursions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
        .run(...cols.map((c) => row[c]));
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const svc = boot(h, ON);
      toDefeated(h, svc);
      const real = h.ctx.heavyEvents;
      h.ctx.heavyEvents = NOT_READY(real);
      svc.runPass(T0 + 2000);
      assert.deepStrictEqual([h.incursion(1).state, h.incursion(1).outcome], ["DECIDED", "defeated"]);
      for (let id = 2; id <= 5; id += 1) copy(h, id, "defeated");
      copy(h, 6, "expired");
      const p = svc.runPass(T0 + 3000);
      assert.strictEqual(p.settled, 1, JSON.stringify({ p, lines: h.lines }));
      assert.deepStrictEqual([h.incursion(6).state, h.incursion(6).effect], ["SETTLED", "RECORDED"]);
      for (let id = 1; id <= 5; id += 1) {
        assert.deepStrictEqual([h.incursion(id).state, Number(h.incursion(id).attempts)], ["DECIDED", 0], `${id}`);
      }
      assert.strictEqual(h.occupation.repel.length, 0);
      svc.stop();
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const svc = boot(h, { ...ON, EVEJS_LNE_FACTION_INCURSIONS_REWARDS_POOL_MAX_HOLD_PASSES: "2" });
      toDefeated(h, svc);
      h.ctx.heavyEvents = NOT_READY(h.ctx.heavyEvents);
      svc.runPass(T0 + 2000);
      svc.runPass(T0 + 3000);
      assert.deepStrictEqual([h.incursion(1).state, Number(h.incursion(1).attempts)], ["DECIDED", 0]);
      svc.runPass(T0 + 4000);
      assert.deepStrictEqual([h.incursion(1).state, h.incursion(1).effect], ["SETTLED", "REPEL_APPLIED"]);
      assert.deepStrictEqual(poolRows(h), []);
      assert.strictEqual(svc.getStatus().counters.rewardPoolSkipped, 1);
      assert.ok(h.lines.includes("factionIncursions: rewards pool skipped HEAVY_EVENTS_UNAVAILABLE"), h.lines.join("\n"));
      svc.stop();
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const svc = boot(h, ON);
      toDefeated(h, svc);
      h.ctx.heavyEvents = { ...h.ctx.heavyEvents,
        incursionParticipantsInTx: () => ({ ok: false, reason: "INVALID_INPUT" }) };
      svc.runPass(T0 + 2000);
      assert.deepStrictEqual([h.incursion(1).state, h.incursion(1).effect, Number(h.incursion(1).attempts)],
        ["SETTLED", "REPEL_APPLIED", 0]);
      assert.strictEqual(svc.getStatus().counters.rewardPoolSkipped, 1);
      assert.ok(h.lines.includes("factionIncursions: rewards pool skipped INVALID_INPUT"), h.lines.join("\n"));
      svc.stop();
    });
  });
};
