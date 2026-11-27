"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { CLAIM_STATES } = require("../../lib/world/occupation/schema");
const S = require("../../lib/heavyEvents/schema");
const { initialMembersOf } = require("../../lib/heavyEvents/catalog");
const { chooseCandidate } = require("../../lib/heavyEvents/candidates");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createLive, pressureOf } = require("../../lib/heavyEvents/live");
const { createRng } = require("../../lib/util/rng");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const INVADER = 500010;
const DEFENDER = 500001;
const SYS = 30000142;
const EVENT = "hev:7:0";
const BEACON = Object.freeze({ x: 1, y: 2, z: 3 });
const FAR = Object.freeze({ x: 1e9, y: 0, z: 0 });
const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

function fakeSeam() {
  return { players: 1, nextId: 7000, alive: new Set(), spawns: [], despawned: [], pos: FAR, distances: [],
    readGrid() {
      return { ok: true, players: Array.from({ length: this.players }, (_, i) => ({ characterId: i + 1 })), copies: 0 };
    },
    spawnPhase(_sys, input) {
      this.spawns.push(input.members.map((m) => m.memberKey));
      this.distances.push(input.spawnDistanceM);
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
      this.despawned.push(...ids);
      for (const id of ids) this.alive.delete(id);
      return { ok: true, removed: ids.length };
    },
    kill(n) {
      for (const id of [...this.alive].slice(0, n === undefined ? this.alive.size : n)) this.alive.delete(id);
    } };
}

function harness(store, over, integrity) {
  const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
  const repo = createHeavyEventRepository({ journal });
  const settings = { ...BASE.heavyEvents, enabled: true, ...(over || {}) };
  const members = initialMembersOf("defense", 1, settings.maxUpscaleSteps, settings).members;
  run(store, (tx) => assert.ok(repo.planInTx(tx, { eventId: EVENT, planKey: `1:${EVENT}`, eventType: "defense",
    tier: 1, systemId: SYS, factionId: INVADER, beneficiaryFactionId: DEFENDER, stationId: "st:def:1", members,
    funded: false, integrity: integrity === undefined ? S.INTEGRITY_START : integrity, seed: 1, at: NOW,
    expiresAt: NOW + settings.plannedTtlMs, dueAt: null }).ok));
  const seam = fakeSeam();
  const sites = { cleaned: [],
    listSitesByEvent: () => ({ ok: true, sites: [{ slot: 0, state: "ACTIVE", position: { ...BEACON } }] }),
    cleanupSitesInTx(_tx, eventId, reason) {
      this.cleaned.push([eventId, reason]);
      return { ok: true };
    } };
  const occupation = { calls: [], keys: new Set(),
    dropInfluenceInTx(tx, spec, key) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push([spec.factionId, spec.points, spec.reason, spec.allowNonController, key]);
      if (this.keys.has(key)) return { ok: true, outcome: "DUPLICATE" };
      this.keys.add(key);
      return { ok: true, outcome: "APPLIED", written: false };
    } };
  const counters = {};
  const hooks = { bump: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, refuse: () => {} };
  const live = createLive({ store, repo, settings, getStations: () => null, getSites: () => sites,
    getPresence: () => ({ isObserved: (id) => id === SYS }), getSeam: () => seam, getOccupation: () => occupation,
    admits: () => true }, hooks);
  const row = () => run(store, (tx) => repo.getInTx(tx, EVENT).row);
  const keysOf = (r, phase) => r.members.filter((m) => m.phase === phase).map((m) => m.key);
  return { live, seam, sites, occupation, counters, row, keysOf, settings };
}

module.exports = ({ test, skip }) => {
  test("HD2 integrity pressure: only live members within pressureRadiusM, weighted by hull class", () => {
    const s = { pressureRadiusM: 30000, pressurePerHullPerMinPermille: 8 };
    const hullOf = new Map([[1, "cruiser"], [2, "battleship"], [3, "battleship"], [4, "battleship"], [5, "carrier"]]);
    const near = { x: BEACON.x + 29000, y: BEACON.y, z: BEACON.z };
    const live = [{ entityId: 1, position: { ...BEACON } }, { entityId: 2, position: near },
      { entityId: 3, position: { x: BEACON.x + 31000, y: BEACON.y, z: BEACON.z } }, { entityId: 4, position: null },
      { entityId: 5, position: { ...BEACON } }];
    assert.strictEqual(pressureOf(live, hullOf, BEACON, 30000, s), 28);
    assert.strictEqual(pressureOf([], hullOf, BEACON, 30000, s), 0);
    assert.strictEqual(pressureOf(live, hullOf, BEACON, 0, s), 0);
  });

  test("HD5 candidate: defense only in a claim state with a defender station; invader any kind but neutral", () => {
    const cfg = { ...BASE.heavyEvents, redoubtEnabled: false, foundryEnabled: false };
    const factsWith = (occupation, stationOwner) => ({ now: NOW, open: [], lastEndedAt: new Map(), systems: [{
      systemId: SYS, band: "lowsec", controllerFactionId: DEFENDER, controllerKind: "empire", occupation,
      stations: [{ stationId: "st:def:1", factionId: stationOwner, state: "ONLINE", hullStock: {}, mineralUnits: 0 }] }] });
    const claim = (state, kind) => ({ state, occupierFactionId: INVADER, occupierKind: kind });
    for (const state of CLAIM_STATES) {
      const ok = chooseCandidate(factsWith(claim(state, "empire"), DEFENDER), cfg, createRng(5));
      assert.ok(ok.ok, `${state} ${JSON.stringify(ok)}`);
      assert.deepStrictEqual([ok.candidate.eventType, ok.candidate.factionId, ok.candidate.beneficiaryFactionId,
        ok.candidate.stationId, ok.candidate.funded, ok.candidate.tier], ["defense", INVADER, DEFENDER, "st:def:1",
        false, 1]);
    }
    assert.strictEqual(chooseCandidate(factsWith(claim("STABLE", "pirate"), DEFENDER), cfg, createRng(5)).reason,
      "NO_CANDIDATE");
    assert.strictEqual(chooseCandidate(factsWith(null, DEFENDER), cfg, createRng(5)).reason, "NO_CANDIDATE");
    assert.strictEqual(chooseCandidate(factsWith(claim(CLAIM_STATES[0], "neutral"), DEFENDER), cfg, createRng(5))
      .reason, "KIND_OFF");
    assert.strictEqual(chooseCandidate(factsWith(claim(CLAIM_STATES[0], "pirate"), INVADER), cfg, createRng(5)).reason,
      "NO_STATION");
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("HD1, HD3, HD4 heavy events defense", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("HD1 waves: due at waveIntervalMs, at once when wiped, a due wave waits above maxShipsPerEvent", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, { maxShipsPerEvent: 20, maxUpscaleSteps: 0 });
      const w = h.settings.waveIntervalMs;
      h.live.pass(NOW);
      let r = h.row();
      assert.deepStrictEqual([r.state, r.phase, r.dueAt, h.seam.spawns.length], ["ENGAGED", 1, NOW + w, 1]);
      assert.strictEqual(h.seam.distances[0], h.settings.waveSpawnDistanceM);
      assert.deepStrictEqual(h.keysOf(r, 2), [], "wave 2 is not in members_json before it is sent");
      h.live.pass(NOW + w - 1);
      assert.strictEqual(h.row().phase, 1);
      h.live.pass(NOW + w);
      r = h.row();
      assert.deepStrictEqual([r.phase, r.dueAt, h.seam.spawns[1].length], [2, NOW + 2 * w, 8]);
      assert.deepStrictEqual(h.keysOf(r, 2), h.seam.spawns[1]);
      assert.ok(h.seam.spawns[1].every((k) => /^p2:[0-9]+$/.test(k)));
      h.seam.kill();
      h.live.pass(NOW + w + 1000);
      r = h.row();
      assert.deepStrictEqual([r.phase, h.seam.spawns[2].length, h.keysOf(r, 1).length + h.keysOf(r, 2).length],
        [3, 11, 14]);
      h.live.pass(NOW + w + 1000 + w);
      assert.deepStrictEqual([h.row().phase, h.counters["deferred.BUDGET"]], [3, 1]);
      h.seam.kill(4);
      h.live.pass(NOW + w + 2000 + w);
      r = h.row();
      assert.deepStrictEqual([r.phase, h.seam.spawns[3].length, h.counters.phase], [4, 12, 3]);
      assert.strictEqual(r.integrity, S.INTEGRITY_START, "invaders far from the beacon do not press");
    });
  });

  test("HD3 success: the last wave wiped -> CLEARED, the invader loses defenseInfluencePoints exactly once", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, { defenseWaves: 2 });
      h.live.pass(NOW);
      h.seam.kill();
      h.live.pass(NOW + 1000);
      assert.strictEqual(h.row().phase, 2);
      h.seam.kill();
      h.live.pass(NOW + 2000);
      const r = h.row();
      assert.deepStrictEqual([r.state, r.rewardState, r.integrity, r.open], ["CLEARED", "PENDING", 1000, true]);
      assert.deepStrictEqual(h.occupation.calls, [[INVADER, h.settings.defenseInfluencePoints, "HEAVY_EVENT_DEFENDED",
        true, S.influenceKeyOf(EVENT)]]);
      assert.strictEqual(h.counters["cleared.defense"], 1);
      const seen = { ...r, state: "ENGAGED", version: r.version - 1 };
      const again = run(store, (tx) => h.live.clearInTx(tx, seen, NOW + 3000, { integrity: 1000 }));
      assert.strictEqual(again.duplicate, true);
      h.live.pass(NOW + 4000);
      assert.deepStrictEqual([h.occupation.calls.length, h.row().version], [1, r.version]);
    });
  });

  test("HD4 integrity 0 -> FAILED INTEGRITY: despawn, beacon released, no influence drop, no chest", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, {}, 50);
      h.seam.pos = BEACON;
      h.live.pass(NOW);
      const ids = [...h.seam.alive];
      h.live.pass(NOW + 30000);
      assert.strictEqual(h.row().state, "ENGAGED");
      h.live.pass(NOW + 60000);
      const r = h.row();
      assert.deepStrictEqual([r.state, r.endReason, r.integrity, r.open, r.rewardState],
        ["FAILED", "INTEGRITY", 0, false, "NONE"]);
      assert.deepStrictEqual(h.occupation.calls, []);
      assert.deepStrictEqual(h.sites.cleaned, [[EVENT, "EVENT_CANCELLED"]]);
      assert.deepStrictEqual([...h.seam.despawned].sort(), ids.sort());
      assert.strictEqual(h.counters["failed.INTEGRITY"], 1);
    });
  });
};
