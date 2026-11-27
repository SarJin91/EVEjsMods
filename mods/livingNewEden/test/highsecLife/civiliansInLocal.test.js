"use strict";

const assert = require("node:assert");

const { startHighsecLife, createUnavailableHighsecLife } = require("../../lib/highsecLife");
const { isMetricName } = require("../../lib/telemetry/registry");
const seamModule = require("../../lib/adapter/localPilots");
const VC_DATA = require("../../lib/strategy/data/virtualCorps");
const LP = require("../localPilots/localPilots.test").harness;
const HS = require("./highsecLife.test").harness;

const SYS_A = HS.SYS_C;
const SYS_B = HS.PERIMETER;
const SYS_LOW = HS.LOW;
const MAX_PER_SYSTEM = 12;
const CIV_CORPS = 6;
const CIV_MEMBERS = 10;
const CIV_CORP_BASE = 98500000;
const T0 = Date.UTC(2026, 10, 10, 17, 0, 1);
const FLAT_CURVE = Array.from({ length: 24 }, () => "1000").join(",");

function civConfig(patch) {
  const c = HS.baseConfig({ ...(patch || {}), hs: { jitterPermille: 0, hourCurvePermille: FLAT_CURVE,
    civilianCorps: CIV_CORPS } });
  return { ...c, localPilots: { ...c.localPilots, maxPilotsPerSystem: MAX_PER_SYSTEM } };
}

function civilianWorld() {
  const w = LP.world();
  const bySlot = new Map();
  const ids = [];
  for (let slot = 1; slot <= CIV_CORPS; slot += 1) {
    const list = [];
    for (let m = 0; m < CIV_MEMBERS; m += 1) {
      const id = 92000000 + slot * 100 + m;
      w.records.set(id, { corporationID: CIV_CORP_BASE + slot, allianceID: 0 });
      list.push(id);
      ids.push(id);
    }
    bySlot.set(slot, list);
  }
  return { w, bySlot, ids: ids.sort((a, b) => a - b) };
}

async function startHs(config, bySlot) {
  const stations = Array.from({ length: 6 }, (_, i) => ({ stationId: 60000100 + i, corporationId: 1000035 }));
  const vc = {
    ensureOwnerIdentity: () => ({ ok: true, queued: true }),
    getOwnerIdentity: (_kind, slot) => ({ ok: true, state: "LINKED", corporationId: CIV_CORP_BASE + slot,
      characterIds: (bySlot.get(slot) || []).slice(), refusedMemberCount: 0 }),
  };
  const graph = HS.fakeGraph();
  const r = startHighsecLife({ config, worldSeed: HS.SEED,
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }), getVirtualCorps: () => vc,
    listStations: (id) => ({ ok: true, stations: id === SYS_A ? stations : [] }),
    bloodlinesOf: (f) => (VC_DATA.getById(f) ? VC_DATA.getById(f).bloodlineIds : null) });
  if (!r.ok) return r;
  await r.highsecLife.whenReady();
  assert.strictEqual(r.highsecLife.getStatus().state, "running");
  return r;
}

function bootScene(civ, highsecLife, more) {
  const clock = { t: T0, now() { return clock.t; } };
  const metrics = [];
  const telemetry = {};
  for (const kind of ["count", "gauge", "observe"]) telemetry[kind] = (name, value) => metrics.push([kind, name, value]);
  const calls = { civilianCandidates: 0 };
  const env = LP.boot({ world: civ.w, clock, telemetry, highsecLife,
    settings: { maxPilotsPerSystem: MAX_PER_SYSTEM },
    presenceState: { observed: [SYS_A, SYS_B, SYS_LOW] },
    virtualCorps: { listCivilianCandidates: () => {
      calls.civilianCandidates += 1;
      return { ok: true, version: 1, characterIds: civ.ids };
    } },
    ...(more || {}) });
  return { ...env, clock, metrics, calls };
}

function rosters(log) {
  const out = new Map();
  for (const [sid, ids] of log.setRoster) out.set(sid, ids);
  return out;
}

function assertNoDuplicates(map) {
  const all = [...map.values()].flat();
  assert.strictEqual(new Set(all).size, all.length, "a character in two systems");
}

module.exports = ({ test }) => {
  test("HSL5 civilians in Local: highsec without fleets = the target, the LNE fleet first then civilians up to "
    + "maxPilotsPerSystem, lowsec none; highsecLife.civiliansWanted/Assigned gauges; Show Info = civilian corp",
  async () => {
    const civ = civilianWorld();
    const hs = await startHs(civConfig(), civ.bySlot);
    try {
      const fleets = new Map([[SYS_B, [LP.fleet(LP.FACTION, null, 3)]]]);
      const env = bootScene(civ, hs.highsecLife, { fleets });
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      const r = rosters(env.vendor.log);
      const civSet = new Set(civ.ids);
      const a = r.get(SYS_A);
      const b = r.get(SYS_B);
      assert.strictEqual(a.length, 8, `A ${a}`);
      assert.ok(a.every((id) => civSet.has(id)), "A = civilians");
      assert.strictEqual(b.length, MAX_PER_SYSTEM, `B ${b}`);
      assert.deepStrictEqual(b.slice(0, 3), [91000001, 91000002, 91000003], "the fleet pilots first");
      assert.ok(b.slice(3).every((id) => civSet.has(id)), "then civilians");
      assert.strictEqual(r.has(SYS_LOW), false, "lowsec: no civilians");
      assertNoDuplicates(r);
      const gauge = (name) => env.metrics.filter((m) => m[0] === "gauge" && m[1] === name).map((m) => m[2]);
      assert.deepStrictEqual(gauge("highsecLife.civiliansWanted"), [17]);
      assert.deepStrictEqual(gauge("highsecLife.civiliansAssigned"), [17]);
      assert.deepStrictEqual(env.metrics.filter((m) => m[1] === "highsecLife.civiliansShortfall"), []);
      assert.deepStrictEqual(gauge("localPilots.pilots"), [20], "pilots = what Local shows");
      for (const name of ["highsecLife.civiliansWanted", "highsecLife.civiliansAssigned",
        "highsecLife.civiliansShortfall"]) assert.strictEqual(isMetricName(name), true, name);
      const st = env.lp.getStatus();
      assert.deepStrictEqual(st.lastPass.civilians, { wanted: 17, assigned: 17, shortfall: 0,
        bucket: Math.floor(T0 / 600000), pool: 60 });
      assert.strictEqual(st.shortfall, 0);
      const member = env.vendor.members.get(SYS_B)[3];
      assert.strictEqual(member.corporation.sequential, civ.w.records.get(b[3]).corporationID);
      assert.ok(member.corporation.sequential > CIV_CORP_BASE && member.corporation.sequential <= CIV_CORP_BASE + 6);
      assert.strictEqual(env.vendor.localOf(SYS_A).length, 8, "the listener appends them");
      env.lp.stop("test");
    } finally {
      hs.highsecLife.stop();
      seamModule._resetForTest();
    }
  });

  test("HSL6 restart + churn: two fresh instances in bucket k = the same rosters; bucket k+1 keeps the old "
    + "roster minus civilianChurn exactly, size = target, no duplicates; a second pass in k+1 changes nothing",
  async () => {
    const civ = civilianWorld();
    const hs = await startHs(civConfig(), civ.bySlot);
    try {
      const fleets = () => new Map([[SYS_B, [LP.fleet(LP.FACTION, null, 3)]]]);
      const first = bootScene(civ, hs.highsecLife, { fleets: fleets() });
      first.lp.runPassNow();
      const firstLog = first.vendor.log.setRoster.slice();
      first.lp.stop("restart");
      const env = bootScene(civ, hs.highsecLife, { fleets: fleets() });
      env.lp.runPassNow();
      assert.deepStrictEqual(env.vendor.log.setRoster, firstLog, "restart in the same bucket = the same roster");

      const before = rosters(env.vendor.log);
      const civSet = new Set(civ.ids);
      const previous = new Map();
      for (const [sid, ids] of before) {
        for (const id of ids) if (civSet.has(id)) previous.set(id, { systemId: sid, poolKey: "civ" });
      }
      const bucket = Math.floor(T0 / 600000);
      const released = hs.highsecLife.civilianChurn(previous, bucket + 1);
      assert.ok(released.size > 0 && released.size < previous.size, `released ${released.size}`);
      env.clock.t += 600000;
      env.lp.runPassNow();
      const after = rosters(env.vendor.log);
      for (const sid of [SYS_A, SYS_B]) {
        const old = before.get(sid);
        const now = after.get(sid);
        const kept = now.filter((id) => old.includes(id));
        assert.deepStrictEqual(kept, old.filter((id) => !released.has(id)), `kept in ${sid}`);
        assert.ok(now.every((id) => !released.has(id)), `no released civilian back in ${sid}`);
      }
      assert.strictEqual(after.get(SYS_A).length, 8);
      assert.strictEqual(after.get(SYS_B).length, MAX_PER_SYSTEM);
      assertNoDuplicates(after);
      assert.strictEqual(env.lp.getStatus().lastPass.civilians.bucket, bucket + 1);
      const count = env.vendor.log.setRoster.length;
      env.lp.runPassNow();
      assert.strictEqual(env.vendor.log.setRoster.length, count, "churn once per bucket");
      env.lp.stop("test");
    } finally {
      hs.highsecLife.stop();
      seamModule._resetForTest();
    }
  });

  test("HSL7 crews RUNNING: roster B = the crew (crews order) then civilians up to the cap; requestEnlist gets "
    + "fleet ids only, never a civilian", async () => {
    const civ = civilianWorld();
    const hs = await startHs(civConfig(), civ.bySlot);
    try {
      const fleets = new Map([[SYS_B, [{ ...LP.fleet(LP.FACTION, LP.CORP, 3), fleetId: "f-1" },
        { ...LP.fleet(LP.FACTION, null, 2), fleetId: "f-2" }]]]);
      const crews = LP.fakeCrews(new Map([["f-1", [91000003, 91000001, 91000005]]]));
      const env = bootScene(civ, hs.highsecLife, { fleets, crews, crewsConfig: LP.CREWS_CONFIG });
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      env.lp.runPassNow();
      const b = rosters(env.vendor.log).get(SYS_B);
      const civSet = new Set(civ.ids);
      assert.deepStrictEqual(b.slice(0, 3), [91000003, 91000001, 91000005], "the crew first, crews order");
      assert.strictEqual(b.length, MAX_PER_SYSTEM);
      assert.ok(b.slice(3).every((id) => civSet.has(id)), "then civilians");
      assert.ok(crews.log.requests.length > 0, "the under-crewed fleet is requested");
      for (const ids of crews.log.requests) {
        assert.ok(ids.every((id) => typeof id === "string"), JSON.stringify(ids));
        assert.ok(!ids.some((id) => civSet.has(id) || civSet.has(Number(id))), JSON.stringify(ids));
      }
      assert.strictEqual(env.lp.getStatus().lastPass.mode, "crews");
      env.lp.stop("test");
    } finally {
      hs.highsecLife.stop();
      seamModule._resetForTest();
    }
  });

  test("HSL8 flag off bit for bit: no ctx.highsecLife / the stub / startHighsecLife disabled_by_config give "
    + "the same setRoster, repush, describe and lastPass; zero listCivilianCandidates, no highsecLife.* metric",
  async () => {
    const civ = civilianWorld();
    const off = startHighsecLife({ config: civConfig({ enabled: false }) });
    assert.deepStrictEqual(off, { ok: false, reason: "disabled_by_config" });
    const variants = { none: undefined, stub: createUnavailableHighsecLife("disabled_by_config"),
      disabled: createUnavailableHighsecLife(off.reason) };
    const out = {};
    for (const [name, highsecLife] of Object.entries(variants)) {
      try {
        const fleets = new Map([[SYS_B, [LP.fleet(LP.FACTION, null, 3)]]]);
        const env = bootScene(civ, highsecLife, { fleets });
        env.lp.runPassNow();
        env.clock.t += 600000;
        fleets.set(SYS_A, [LP.fleet(LP.FACTION, null, 2)]);
        env.lp.runPassNow();
        const { at: _at, ms: _ms, ...lastPass } = env.lp.getStatus().lastPass;
        out[name] = { setRoster: env.vendor.log.setRoster, repush: env.vendor.log.repush,
          describe: env.vendor.log.describe, lastPass };
        assert.strictEqual(env.calls.civilianCandidates, 0, `${name}: listCivilianCandidates`);
        assert.deepStrictEqual(env.metrics.filter((m) => m[1].startsWith("highsecLife.")), [], name);
        assert.strictEqual("civilians" in lastPass, false, name);
        env.lp.stop("test");
      } finally {
        seamModule._resetForTest();
      }
    }
    assert.deepStrictEqual(out.stub, out.none);
    assert.deepStrictEqual(out.disabled, out.none);
    assert.deepStrictEqual(out.none.setRoster, [[SYS_B, [91000001, 91000002, 91000003]],
      [SYS_A, [91000004, 91000005]]]);
  });
};
