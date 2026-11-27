"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { settingsOf, STATE, INTENT, ARCHETYPE } = require("../../lib/population/schema");
const { TRAFFIC_METRICS } = require("../../lib/highsecLife/schema");
const { pilotHullProfilesOf } = require("../../lib/highsecLife/traffic/plan");
const CIV = require("../../lib/adapter/data/civilianLiveProfiles");
const { createRng } = require("../../lib/util/rng");
const { findCompose } = require("../config/composeKeys.test");
const { rig: G } = require("./groups.test");
const { rig: TP } = require("../highsecLife/trafficPilots.test");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { NOW, SYS } = G;
const SIZE = 6;
const HURRICANE = 24702;
const BADGER = 648;
const KEYS = ["EVEJS_LNE_POPULATION_GROUPS_LIVE_SPAWN_ENABLED", "EVEJS_LNE_POPULATION_GROUPS_LIVE_SPACING_METERS"];
const LIVE = Object.freeze({ near: { enabled: true, attractPermille: 0 }, live: { trafficEnabled: true } });

const liveDeps = (systems) => (graph) => ({ getPresence: () => G.presenceOf(graph, systems || graph.getSystemIds()),
  liveMaxOwned: 12 });

function groupHarness({ groups, maxShipsPerSystem = 3, refuseClaim, live, telemetry, cands } = {}) {
  const pop = TP.fakePopulation(cands || [TP.cand(1, "HAULER", "GATE", TP.FROM, TP.NEXT)], "running",
    { groups, refuseClaim });
  const h = TP.harness({ pop, settings: TP.T({ maxShipsPerSystem }), groupSpawn: { spacingMeters: 500 }, live,
    extra: telemetry ? { telemetry } : undefined });
  return { h, pop };
}

const member = (pilotId) => ({ pilotId, shipTypeId: BADGER });
const spawnsOf = (h) => h.log.filter((e) => e[0] === "spawn").map((e) => e[1]);
const despawnsOf = (h) => h.log.filter((e) => e[0] === "despawn").map((e) => e[1]);

function looksOf(over = {}) {
  const looks = new Map();
  for (const e of pilotHullProfilesOf(CIV.civilianDataOf({ pilotHulls: true })).values()) {
    looks.set(e.shipTypeId, { typeId: e.shipTypeId, graphicID: e.shipTypeId, categoryID: 6 });
    looks.set(e.presentationTypeId, { typeId: e.presentationTypeId, graphicID: e.shipTypeId, categoryID: 11 });
  }
  for (const [id, look] of Object.entries(over)) looks.set(Number(id), { typeId: Number(id), ...look });
  return looks;
}

function flyToArrival(svc) {
  for (let i = 0; i < 40; i += 1) {
    if (svc.pilot(1).state !== "TRAVEL") return svc.pilot(1).systemId;
    svc.runPass(svc.pilot(1).dueAt);
  }
  throw new Error(`the leader never arrived: ${JSON.stringify(svc.pilot(1))}`);
}

module.exports = ({ test }) => {
  test("GL1 population: liveGroupOf after the claim, releaseGroupMember = POD + out of the group, EMPTY; flag off",
    async () => {
      const { svc, members } = await G.formed({ ...LIVE, groups: G.groupsOn({ minMembers: 3, maxSize: 3,
        liveSpawnEnabled: true }) }, { deps: liveDeps([SYS]) });
      assert.strictEqual(members.length, 3, JSON.stringify(members));
      assert.deepStrictEqual(svc.liveGroupOf(1, SYS, NOW), { ok: false, reason: "NOT_OWNED" });
      const c = svc.claimLive(1, SYS, NOW);
      assert.ok(c.ok, JSON.stringify(c));
      const g = svc.liveGroupOf(1, SYS, NOW);
      assert.deepStrictEqual([g.ok, g.members.map((m) => m.pilotId)], [true, members]);
      for (const m of g.members) assert.strictEqual(m.shipTypeId, svc.pilot(m.pilotId).shipTypeId);
      assert.deepStrictEqual(svc.liveGroupOf(1, F.sid(6), NOW), { ok: false, reason: "NOT_OWNED" });

      const [m1, m2, m3] = members;
      const q0 = svc.getStatus().queue;
      assert.deepStrictEqual(svc.releaseGroupMember(m1, 1, c.token, NOW + 1000), { ok: true, applied: true,
        state: "POD" });
      const st = svc.getStatus();
      assert.deepStrictEqual([svc.pilot(m1).state, "groupId" in svc.pilot(m1), st.queue, st.counters["live.memberKilled"],
        st.groups.members, st.groups.groups], ["POD", false, q0 + 1, 1, 2, 1]);
      assert.deepStrictEqual(svc.releaseGroupMember(m1, 1, c.token, NOW + 1000), { ok: true, applied: false });
      assert.deepStrictEqual(svc.releaseGroupMember(m2, 1, c.token + 999, NOW + 1000), { ok: true, applied: false });
      assert.strictEqual(svc.pilot(m2).groupId, 1);
      assert.strictEqual(svc.releaseGroupMember(m2, 1, c.token, NOW + 2000).applied, true);
      assert.strictEqual(svc.releaseGroupMember(m3, 1, c.token, NOW + 2000).applied, true);
      const end = svc.getStatus();
      assert.deepStrictEqual([end.groups.groups, end.groups.members, end.groups.dissolvedBy.EMPTY,
        end.counters["live.memberKilled"], "groupId" in svc.pilot(1), end.liveOwned], [0, 0, 1, 3, false, 1]);
      svc.stop();

      const off = await G.formed({ ...LIVE, groups: G.groupsOn({ minMembers: 3, maxSize: 3 }) },
        { deps: liveDeps([SYS]) });
      const c2 = off.svc.claimLive(1, SYS, NOW);
      assert.deepStrictEqual(off.svc.liveGroupOf(1, SYS, NOW), { ok: false, reason: "OFF" });
      assert.deepStrictEqual(off.svc.releaseGroupMember(off.members[0], 1, c2.token, NOW), { ok: true, applied: false });
      assert.strictEqual(off.svc.pilot(off.members[0]).groupId, 1);
      off.svc.stop();
    });

  test("GL2 END dissolution: members out of the limit, arrivals, the used mark", async () => {
    const over = { ...LIVE, maxEventsPerPass: 1, groups: G.groupsOn({ liveSpawnEnabled: true }) };
    const a = await G.formed(over, { deps: liveDeps(null) });
    assert.deepStrictEqual(a.svc.liveCandidatesIn(SYS, NOW - 60000, 1).map((c) => c.pilotId), [1]);
    assert.deepStrictEqual(a.svc.liveCandidatesIn(SYS, NOW - 60000, 10).map((c) => c.pilotId), [1]);
    const x = flyToArrival(a.svc);
    assert.notStrictEqual(x, SYS);
    assert.strictEqual(a.svc.getStatus().groups.groups, 1);
    const arrived = a.svc.arrivalsInto(x, NOW - 1, 10).map((e) => e.pilotId);
    for (const id of [1, ...a.members]) assert.ok(arrived.includes(id), `${id} in ${JSON.stringify(arrived)}`);
    const formedBefore = a.svc.getStatus().counters["groups.formed"];
    a.svc.runPass(a.svc.pilot(1).dueAt);
    const st = a.svc.getStatus();
    assert.deepStrictEqual([st.groups.dissolvedBy.END, st.groups.dissolvedBy.LIFETIME, st.groups.groups,
      st.counters["groups.formed"], st.queue], [1, 0, 0, formedBefore, SIZE]);
    for (const id of a.members) assert.ok(!("groupId" in a.svc.pilot(id)), String(id));
    a.svc.stop();

    const b = await G.formed(over, { deps: liveDeps(null) });
    const y = flyToArrival(b.svc);
    const t = b.svc.pilot(1).sinceAt;
    assert.ok(!b.svc.liveCandidatesIn(y, NOW - 1, 10).some((c) => b.members.includes(c.pilotId)));
    const c = b.svc.claimLive(1, y, t);
    assert.ok(c.ok, JSON.stringify(c));
    assert.deepStrictEqual(b.svc.liveGroupOf(1, y, t).members.map((m) => m.pilotId), b.members);
    assert.strictEqual(b.svc.releaseLive(1, c.token, "KILLED", t).state, "POD");
    assert.strictEqual(b.svc.getStatus().groups.dissolvedBy.POD, 1);
    for (const id of b.members) {
      assert.strictEqual(b.svc.pilot(id).systemId, y);
      assert.ok(!("groupId" in b.svc.pilot(id)));
    }
    assert.ok(!b.svc.liveCandidatesIn(y, NOW - 1, 10).some((cd) => b.members.includes(cd.pilotId)),
      "an entry before the used mark gives no second ship");
    b.svc.stop();
  });

  test("GL3 traffic: one claim, member ships with spacing, caps, member KILLED, leader ARRIVED / KILLED, mix", () => {
    const gauges = new Map();
    const telemetry = { gauge: (n, v) => gauges.set(n, v), count() {}, observe() {} };
    const { h, pop } = groupHarness({ groups: new Map([[1, [member(11), member(12), member(13)]]]), telemetry });
    h.tick();
    const sp = spawnsOf(h);
    assert.deepStrictEqual(pop.calls.claim, [1]);
    assert.deepStrictEqual(sp.map((s) => [s.gateId, s.stationId, s.spawnOffsetMeters]), [[50001, undefined, 3000],
      [50001, undefined, 3500], [50001, undefined, 4000]]);
    let c = h.traffic.status().counters;
    assert.deepStrictEqual([c.spawned, c.pilotSpawned, c.groupMemberSpawned, c.groupMembersCapped,
      h.traffic.status().pilots], [3, 1, 2, 1, 3]);
    assert.deepStrictEqual([gauges.get(TRAFFIC_METRICS.pilotDuplicates), gauges.get(TRAFFIC_METRICS.maxPerSystem),
      gauges.get(TRAFFIC_METRICS.pilotShips)], [0, 3, 3]);
    const [leaderId, ship11, ship12] = [...h.alive.keys()];
    const token = pop.owned.get(1);
    h.alive.delete(ship11);
    h.tick();
    assert.deepStrictEqual(pop.calls.memberRelease, [[11, 1, token, true]]);
    assert.deepStrictEqual(pop.calls.release, []);
    for (let i = 0; i < 20 && pop.calls.release.length === 0; i += 1) h.tick();
    assert.deepStrictEqual(pop.calls.release, [[1, "JUMPED"]]);
    assert.ok(despawnsOf(h).some((ids) => ids.length === 2 && ids.includes(leaderId) && ids.includes(ship12)),
      JSON.stringify(despawnsOf(h)));
    c = h.traffic.status().counters;
    assert.deepStrictEqual([c.pilotKilled, h.traffic.status().ships, h.traffic.status().pilots], [1, 0, 0]);

    const k = groupHarness({ groups: new Map([[1, [member(11), member(12), member(13)]]]), maxShipsPerSystem: 4,
      refuseClaim: new Set([13]) });
    k.h.tick();
    const [kl, k11, k12, k13] = [...k.h.alive.keys()];
    const kt = k.pop.owned.get(1);
    k.h.alive.delete(kl);
    k.h.alive.delete(k11);
    k.h.tick();
    assert.deepStrictEqual(k.pop.calls.memberRelease, [[11, 1, kt, true]]);
    assert.deepStrictEqual(k.pop.calls.release, [[1, "KILLED"]]);
    assert.deepStrictEqual(k.pop.calls.claim, [1, 12, 13]);
    const kc = k.h.traffic.status().counters;
    assert.deepStrictEqual([kc.groupMembersReclaimed, kc.groupMembersDropped, kc.pilotKilled, k.h.traffic.status().ships,
      k.h.traffic.status().pilots], [1, 1, 2, 1, 1]);
    assert.ok(despawnsOf(k.h).some((ids) => ids.length === 1 && ids[0] === k13), JSON.stringify(despawnsOf(k.h)));
    assert.ok(k.h.alive.has(k12));
    for (let i = 0; i < 20 && k.pop.calls.release.length === 1; i += 1) k.h.tick();
    assert.deepStrictEqual(k.pop.calls.release, [[1, "KILLED"], [12, "JUMPED"]]);

    const m = groupHarness({ groups: new Map([[7, [member(17)]]]), maxShipsPerSystem: 4,
      live: { ...TP.LIVE_ON, trafficMode: "mix" }, cands: [TP.cand(7, "HAULER", "STATION", TP.FROM, 0)] });
    m.h.tick();
    const mc = m.h.traffic.status().counters;
    assert.deepStrictEqual([spawnsOf(m.h).length, mc.pilotSpawned, mc.groupMemberSpawned, mc.spawned], [2, 1, 1, 2]);
    assert.strictEqual(spawnsOf(m.h)[1].spawnOffsetMeters, 3500);
  });

  test("GL4: a rejected hull takes no place in maxSpawnsPerSystemPass (population, traffic)", async () => {
    const rows = [1, 2].map((id) => G.row(id, { archetype: ARCHETYPE.TRADER, ship_type_id: id === 1 ? HURRICANE : BADGER,
      system_id: F.sid(2), dest_id: SYS, intent: INTENT.TRAVEL, state: STATE.TRAVEL, due_at: NOW }));
    const db = { rows: new Map(rows.map((r) => [r.pilot_id, r])), meta: { rules_version: 1, size: 2, seeded_at: 1,
      flushed_at: 1 } };
    const { svc } = await G.service(F.settings(G.base({ size: 2, ...LIVE })), G.memStore(db),
      { deps: liveDeps([SYS]) });
    svc.runPass(NOW);
    assert.deepStrictEqual(svc.liveCandidatesIn(SYS, NOW - 60000, 1).map((c) => c.pilotId), [1]);
    assert.deepStrictEqual(svc.liveCandidatesIn(SYS, NOW - 60000, 1, (t) => t !== HURRICANE).map((c) => c.pilotId),
      [2]);
    svc.stop();

    const pop = TP.fakePopulation([{ ...TP.cand(2, "HAULER", "GATE", TP.FROM, TP.NEXT), shipTypeId: HURRICANE },
      { ...TP.cand(3, "HAULER", "GATE", TP.FROM, TP.NEXT), shipTypeId: BADGER }], "running", { accept: true });
    const h = TP.harness({ pop, extra: { populationLive: { settings: { ...TP.LIVE_ON, maxSpawnsPerSystemPass: 1 },
      getPopulation: () => pop, leaseOf: () => ({ ok: true, characterId: null }),
      hullProfiles: pilotHullProfilesOf(CIV.civilianDataOf({ pilotHulls: true })),
      readTypeLooks: () => ({ ok: true, looks: looksOf({ 46080: { graphicID: 1, categoryID: 11 } }), missing: [] }) } } });
    h.tick(2);
    assert.deepStrictEqual(pop.calls.claim, [3]);
    assert.ok(h.traffic.status().counters.pilotNoLiveProfile >= 1);
    assert.deepStrictEqual(spawnsOf(h).map((s) => s.profileId), ["lne_civ_badger"]);
  });

  test("GL5 flag off bit for bit (population, traffic) and config (2 keys, W259, W264, compose, .env.example)",
    async () => {
      const over = { size: 120, seedRowsPerSlice: 200, flushRowsPerSlice: 400, maxRoutesPerPass: 5000 };
      const population = F.populationConfig(G.base({ ...over, groups: G.groupsOn() }));
      const { liveSpawnEnabled: _a, liveSpacingMeters: _b, ...noKey } = population.groups;
      const runs = [];
      for (const S of [settingsOf({ population: { ...population, groups: noKey } }),
        F.settings(G.base({ ...over, groups: G.groupsOn({ liveSpawnEnabled: false }) }))]) {
        const store = G.memStore();
        const { svc } = await G.service(S, store);
        for (let i = 0; i < 40; i += 1) svc.runPass(NOW + i * 60000);
        runs.push({ views: Array.from({ length: 120 }, (_, i) => svc.pilot(i + 1)), rows: [...store.db.rows.values()],
          groups: svc.getStatus().groups });
        svc.stop();
      }
      assert.deepStrictEqual(runs[0], runs[1]);
      assert.ok(runs[0].groups.groups + runs[0].groups.dissolvedBy.END + runs[0].groups.dissolvedBy.LIFETIME > 0,
        "groups formed");

      const run = (groupSpawn, groups) => {
        const pop = TP.fakePopulation([TP.cand(1, "HAULER", "GATE", TP.FROM, TP.NEXT),
          TP.cand(2, "UNDOCK", "GATE", 0, TP.NEXT)], "running", { groups });
        const h = TP.harness({ pop, rng: createRng(20261124).nextFloat, groupSpawn });
        h.tick(60);
        return { log: JSON.stringify(h.log), counters: h.traffic.status().counters, calls: pop.calls.claim,
          group: pop.calls.group.length };
      };
      const before = run(null, undefined);
      const noSpawn = run(null, new Map([[1, [member(11)]]]));
      const noFacade = run({ spacingMeters: 500 }, undefined);
      assert.deepStrictEqual(noSpawn, before);
      assert.deepStrictEqual(noFacade, before);
      assert.ok(before.counters.pilotSpawned >= 2, JSON.stringify(before.counters));
      for (const k of ["groupMemberSpawned", "groupMembersCapped", "groupMemberNoProfile", "groupMembersReclaimed",
        "groupMembersDropped"]) assert.strictEqual(before.counters[k], 0, k);

      const env0 = { EVEJS_DATA_ROOT: os.tmpdir() };
      const def = resolveConfig({ modDir: MOD_DIR, env: env0 });
      assert.deepStrictEqual([def.config.population.groups.liveSpawnEnabled, def.config.population.groups.liveSpacingMeters],
        [false, 500]);
      assert.ok(!def.warnings.some((w) => /W259|W264/.test(w)));
      const w259 = resolveConfig({ modDir: MOD_DIR, env: { ...env0, EVEJS_LNE_POPULATION_ENABLED: "1",
        EVEJS_LNE_POPULATION_GROUPS_LIVE_SPAWN_ENABLED: "1" } }).warnings;
      assert.ok(w259.some((w) => /\(W259\)/.test(w)) && !w259.some((w) => /W264/.test(w)), w259.join(" | "));
      const on = { ...env0, EVEJS_LNE_POPULATION_ENABLED: "1", EVEJS_LNE_POPULATION_GROUPS_ENABLED: "1",
        EVEJS_LNE_POPULATION_NEAR_ENABLED: "1", EVEJS_LNE_POPULATION_LIVE_TRAFFIC_ENABLED: "1",
        EVEJS_LNE_POPULATION_GROUPS_LIVE_SPAWN_ENABLED: "1" };
      const w264 = resolveConfig({ modDir: MOD_DIR, env: on }).warnings;
      assert.ok(w264.some((w) => /maxSize=4 \+ 1 above highsecLife\.traffic\.maxShipsPerSystem=4 .*\(W264\)/.test(w))
        && !w264.some((w) => /W259/.test(w)), w264.join(" | "));
      const fits = resolveConfig({ modDir: MOD_DIR, env: { ...on, EVEJS_LNE_POPULATION_GROUPS_MAX_SIZE: "3" } });
      assert.ok(!fits.warnings.some((w) => /W259|W264/.test(w)), fits.warnings.join(" | "));
      const modEnv = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
      const rootEnv = fs.readFileSync(path.join(MOD_DIR, "..", "..", ".env.example"), "utf8");
      assert.deepStrictEqual(KEYS.filter((k) => !modEnv.includes(`# ${k}=`) || !rootEnv.includes(`# ${k}=`)), []);
      const composeFile = findCompose();
      if (composeFile) {
        const text = fs.readFileSync(composeFile, "utf8");
        assert.deepStrictEqual(KEYS.filter((k) => !text.includes(`${k}: \${${k}:-${k.endsWith("_ENABLED") ? "0" : ""}}`)),
          []);
      }
    });
};
