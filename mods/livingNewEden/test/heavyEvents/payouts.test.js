"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const S = require("../../lib/heavyEvents/schema");
const { initialMembersOf } = require("../../lib/heavyEvents/catalog");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createLive } = require("../../lib/heavyEvents/live");
const { createHeavyEventPayoutRepository } = require("../../lib/heavyEvents/payoutRepository");
const { createHeavyEventPayoutPump, legKeyOf } = require("../../lib/heavyEvents/payouts");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const INVADER = 500010;
const DEFENDER = 500001;
const DEFENDER_CORP = 1000035;
const NO_CORP_FACTION = 500021;
const SYS = 30000142;
const EVENT = "hev:8:0";
const BEACON = Object.freeze({ x: 1, y: 2, z: 3 });
const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

function fakeSeam() {
  return { chars: [1], nextId: 7000, alive: new Set(), pos: { x: 1e9, y: 0, z: 0 },
    readGrid() {
      return { ok: true, players: this.chars.map((characterId) => ({ characterId, entityId: characterId + 100 })),
        copies: 0 };
    },
    spawnPhase(_sys, input) {
      const spawned = input.members.map((m) => {
        const entityId = this.nextId++;
        this.alive.add(entityId);
        return { memberKey: m.memberKey, entityId, hullGroup: m.hullGroup };
      });
      return { ok: true, spawned, unspawnable: [] };
    },
    readMembers(_sys, ids) {
      return { ok: true, live: ids.filter((id) => this.alive.has(id)).map((entityId) => ({ entityId,
        position: { ...this.pos } })), gone: ids.filter((id) => !this.alive.has(id)) };
    },
    despawn(_sys, ids) {
      for (const id of ids) this.alive.delete(id);
      return { ok: true, removed: ids.length };
    },
    kill() {
      this.alive.clear();
    } };
}

function harness(store, over, integrity) {
  const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
  const repo = createHeavyEventRepository({ journal });
  const payoutRepo = createHeavyEventPayoutRepository();
  const settings = { ...BASE.heavyEvents, enabled: true, maxUpscaleSteps: 0, ...(over || {}) };
  const members = initialMembersOf("defense", 1, settings.maxUpscaleSteps, settings).members;
  run(store, (tx) => assert.ok(repo.planInTx(tx, { eventId: EVENT, planKey: `1:${EVENT}`, eventType: "defense",
    tier: 1, systemId: SYS, factionId: INVADER, beneficiaryFactionId: DEFENDER, stationId: "st:def:1", members,
    funded: false, integrity: integrity === undefined ? S.INTEGRITY_START : integrity, seed: 1, at: NOW,
    expiresAt: NOW + settings.plannedTtlMs, dueAt: null }).ok));
  const seam = fakeSeam();
  const sites = { listSitesByEvent: () => ({ ok: true, sites: [{ slot: 0, state: "ACTIVE", position: { ...BEACON } }] }),
    cleanupSitesInTx: () => ({ ok: true }) };
  const counters = {};
  const hooks = { bump: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, refuse: () => {} };
  const live = createLive({ store, repo, settings, getStations: () => null, getSites: () => sites,
    getPresence: () => ({ isObserved: (id) => id === SYS }), getSeam: () => seam, getOccupation: () => null,
    payoutRepo, admits: () => true }, hooks);
  const row = () => run(store, (tx) => repo.getInTx(tx, EVENT).row);
  const payouts = () => run(store, (tx) => payoutRepo.listPayoutsOfEventInTx(tx, EVENT).rows);
  return { live, seam, counters, row, payouts, settings, payoutRepo };
}

function fakeAdapter() {
  const receipts = new Set();
  const credits = [];
  const calls = [];
  const adapter = {
    rewardSeams: () => ({ ok: true }),
    async rewardCreditIsk(spec) {
      calls.push(["isk", spec]);
      if (receipts.has(spec.commandId)) return { ok: true, duplicate: true };
      receipts.add(spec.commandId);
      credits.push(["isk", spec.characterId]);
      return { ok: true, duplicate: false };
    },
    rewardCreditLp(spec) {
      calls.push(["lp", spec]);
      if (receipts.has(spec.commandId)) return { ok: true, duplicate: true };
      receipts.add(spec.commandId);
      credits.push(["lp", spec.characterId, spec.amountLp]);
      return { ok: true, duplicate: false };
    },
    applyStandingGrant(grant, data) {
      calls.push(["std", grant, data]);
      if (receipts.has(grant.key)) return { ok: true, outcome: "DUPLICATE" };
      receipts.add(grant.key);
      credits.push(["std", grant.characterId, grant.rawChange]);
      return { ok: true, outcome: "APPLIED" };
    },
  };
  return { adapter, credits, calls };
}

function pumpOf(store, adapter, settings) {
  const counters = {};
  const pump = createHeavyEventPayoutPump({ store, repo: createHeavyEventPayoutRepository(), adapter,
    params: { payoutEnabled: true, payoutMaxPerPass: settings.payoutMaxPerPass,
      payoutMaxAttempts: settings.payoutMaxAttempts, payoutRetryBaseMs: settings.payoutRetryBaseMs,
      payoutRetryMaxMs: settings.payoutRetryMaxMs, payoutRetentionMs: settings.payoutRetentionMs,
      prunePerPass: settings.pruneBatch },
    count: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, isStopped: () => false });
  return { pump, counters };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("HP1 success: rows for the participants (pass threshold, present at success), maxParticipants cap", () =>
    H.withStore(driver, (reopen) => {
      const { store } = reopen();
      const h = harness(store, { defenseWaves: 2, minParticipantPasses: 2, maxParticipants: 3 });
      h.seam.chars = [1, 2, 3, 4, 5];
      h.live.pass(NOW);
      h.seam.kill();
      h.live.pass(NOW + 1000);
      h.seam.chars = [1, 2, 9];
      h.live.pass(NOW + 2000);
      assert.deepStrictEqual(h.payouts(), []);
      h.seam.kill();
      h.seam.chars = [9, 10];
      h.live.pass(NOW + 3000);
      assert.strictEqual(h.row().state, "CLEARED");
      const rows = h.payouts();
      assert.deepStrictEqual(rows.map((r) => [r.payoutKey, r.characterId]), [[`${EVENT}:1`, 1], [`${EVENT}:2`, 2],
        [`${EVENT}:9`, 9]]);
      for (const r of rows) {
        assert.deepStrictEqual([r.issuerFactionId, r.systemId, r.lpCorporationId, r.lpAmount, r.standingMicro,
          r.iskAmount, r.iskState, r.lpState, r.stdState, r.state, r.attempts, r.nextAttemptAt],
        [DEFENDER, SYS, DEFENDER_CORP, 1500, 50000, 0, "SKIPPED", "PENDING", "PENDING", "PENDING", 0, NOW + 3000]);
      }
      assert.strictEqual(h.counters["payout.planned"], 3);
      assert.strictEqual(h.counters["payout.planFailed"], undefined);
    }));

  needsDriver("HP2 LP / standing exactly once: crash between the vendor and the marker -> vendor duplicate -> PAID", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      const h = harness(store);
      run(store, (tx) => assert.ok(h.payoutRepo.planPayoutsInTx(tx, { eventId: EVENT, issuerFactionId: DEFENDER,
        systemId: SYS, characterIds: [42], iskAmount: 0, lpAmount: 1500, standingMicro: 50000, at: NOW }).ok));
      const { adapter, credits, calls } = fakeAdapter();
      const crashing = { limits: store.limits, transaction: (name, fn) => (name === "heavyEvents.payoutMark"
        ? { ok: false, reason: "TX_FAILED", error: new Error("crash") } : store.transaction(name, fn)) };
      const first = pumpOf(crashing, adapter, h.settings);
      const s1 = await first.pump.runPass(NOW);
      assert.deepStrictEqual([s1.paid, s1.markFailed], [0, 1]);
      assert.deepStrictEqual(h.payouts().map((r) => r.state), ["PENDING"]);
      const second = pumpOf(store, adapter, h.settings);
      const s2 = await second.pump.runPass(NOW + 1);
      assert.strictEqual(s2.paid, 1);
      assert.deepStrictEqual(h.payouts().map((r) => [r.iskState, r.lpState, r.stdState, r.state]),
        [["SKIPPED", "DONE", "DONE", "PAID"]]);
      assert.deepStrictEqual(credits, [["lp", 42, 1500], ["std", 42, 0.05]], "one credit per leg");
      assert.strictEqual(second.counters["payout.duplicates"], 2);
      const key = `${EVENT}:42`;
      const lp = calls.find((c) => c[0] === "lp")[1];
      assert.deepStrictEqual(lp, { characterId: 42, amountLp: 1500, issuerCorporationId: DEFENDER_CORP,
        commandId: legKeyOf(key, "lp") });
      const std = calls.find((c) => c[0] === "std");
      assert.deepStrictEqual([std[1], std[2]], [{ key: `lne:${key}:std`, characterId: 42, factionId: DEFENDER,
        rawChange: 0.05, reason: "HEAVY_EVENT_DEFENSE" }, { eventTypeId: 486,
        msgByReason: { HEAVY_EVENT_DEFENSE: "Outpost defense (Living New Eden)",
          EVENT_ANOMALY: "Event anomaly (Living New Eden)" } }]);
      await second.pump.runPass(NOW + 2);
      assert.strictEqual(calls.length, 4, "a PAID row never returns to the pump");
    }));

  needsDriver("HP3 defender faction without a corporation in factionCatalog -> LP leg SKIPPED", () =>
    H.withStore(driver, (reopen) => {
      const { store } = reopen();
      const repo = createHeavyEventPayoutRepository();
      const r = run(store, (tx) => repo.planPayoutsInTx(tx, { eventId: EVENT, issuerFactionId: NO_CORP_FACTION,
        systemId: SYS, characterIds: [7, 8], iskAmount: 0, lpAmount: 1500, standingMicro: 50000, at: NOW }));
      assert.deepStrictEqual([r.ok, r.planned, r.lpCorporationId], [true, 2, null]);
      const rows = run(store, (tx) => repo.listPayoutsOfEventInTx(tx, EVENT).rows);
      assert.deepStrictEqual(rows.map((x) => [x.characterId, x.lpCorporationId, x.lpState, x.stdState, x.state]),
        [[7, null, "SKIPPED", "PENDING", "PENDING"], [8, null, "SKIPPED", "PENDING", "PENDING"]]);
      const again = run(store, (tx) => repo.planPayoutsInTx(tx, { eventId: EVENT, issuerFactionId: NO_CORP_FACTION,
        systemId: SYS, characterIds: [7, 8], iskAmount: 0, lpAmount: 1500, standingMicro: 50000, at: NOW + 5 }));
      assert.strictEqual(again.planned, 0);
    }));

  needsDriver("HP4 failure (integrity 0) plans no payout", () =>
    H.withStore(driver, (reopen) => {
      const { store } = reopen();
      const h = harness(store, { minParticipantPasses: 1 }, 50);
      h.seam.pos = { ...BEACON };
      h.live.pass(NOW);
      h.live.pass(NOW + 30000);
      h.live.pass(NOW + 60000);
      assert.deepStrictEqual([h.row().state, h.row().endReason], ["FAILED", "INTEGRITY"]);
      assert.deepStrictEqual(h.payouts(), []);
      assert.strictEqual(h.counters["payout.planned"], undefined);
    }));
};
