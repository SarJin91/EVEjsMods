"use strict";

const assert = require("node:assert");

const { startHighsecLife, createUnavailableHighsecLife } = require("../../lib/highsecLife");
const VC_DATA = require("../../lib/strategy/data/virtualCorps");
const HS = require("./highsecLife.test").harness;

const SYS_BIG = 30000142;
const SYS_SMALL = 30000144;
const NAMELESS = 9105;

function fakeVc() {
  const vc = { version: 1, calls: 0, getMapVersion: () => vc.version, ensureOwnerIdentity: () => ({ ok: true }),
    getOwnerIdentity(_kind, slot) {
      vc.calls += 1;
      const n = slot === 1 ? 7 : slot === 2 ? 2 : 0;
      if (n === 0) return { ok: true, state: "PENDING" };
      const characterIds = Array.from({ length: n }, (_, i) => slot * 100 + 9000 + i);
      return { ok: true, state: "LINKED", characterIds, refusedMemberCount: 0,
        memberNames: characterIds.map((id) => (id === NAMELESS ? null : `Civ ${id}`)) };
    } };
  return vc;
}

async function startRoster() {
  const base = HS.baseConfig({ hs: { civilianCorps: 2, civilianMembersPerCorp: 7 } });
  const H = base.highsecLife;
  const off = (o) => ({ ...(o || {}), enabled: false });
  const config = { ...base, highsecLife: { ...H, chatter: off(H.chatter), traffic: off(H.traffic),
    gank: off(H.gank) } };
  const vc = fakeVc();
  const r = startHighsecLife({ config, worldSeed: HS.SEED,
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph: HS.fakeGraph() }) }),
    getVirtualCorps: () => vc, listStations: () => ({ ok: true, stations: [] }),
    bloodlinesOf: (f) => (VC_DATA.getById(f) ? VC_DATA.getById(f).bloodlineIds : null) });
  assert.ok(r.ok, JSON.stringify(r));
  await r.highsecLife.whenReady();
  assert.strictEqual(r.highsecLife.getStatus().state, "running");
  assert.strictEqual(r.highsecLife.getStatus().chatter.state, "off");
  return { hs: r.highsecLife, vc };
}

const bySystem = () => new Map([[SYS_SMALL, [9201, 9200]], [SYS_BIG, [9106, 9105, 9104, 9103, 9102, 9101, 9100]]]);

module.exports = ({ test }) => {
  test("R1 roster with the chatter off: count desc, names capped, a nameless id counted; maxNames 0", async () => {
    const { hs } = await startRoster();
    try {
      hs.noteCivilians(bySystem(), 1234);
      const r = hs.listCivilianRoster({ maxNames: 3 });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.atMs, 1234);
      assert.deepStrictEqual(r.systems.map((s) => [s.systemId, s.count]), [[SYS_BIG, 7], [SYS_SMALL, 2]]);
      assert.deepStrictEqual(r.systems[0].names, ["Civ 9100", "Civ 9101", "Civ 9102"]);
      assert.deepStrictEqual(r.systems[1].names, ["Civ 9200", "Civ 9201"]);
      const all = hs.listCivilianRoster({ maxNames: 50 });
      assert.strictEqual(all.systems[0].count, 7);
      assert.strictEqual(all.systems[0].names.length, 6, "the id without a name is counted, not named");
      assert.ok(!all.systems[0].names.some((n) => n.includes(String(NAMELESS))));
      const counts = hs.listCivilianRoster({ maxNames: 0 });
      assert.deepStrictEqual(counts.systems.map((s) => s.names), [[], []]);
      assert.deepStrictEqual(hs.listCivilianRoster({ maxNames: -1 }).systems[0].names, []);
    } finally {
      hs.stop();
    }
  });

  test("R2 empty roster, stop -> NOT_RUNNING, the stub refuses with its reason", async () => {
    const { hs } = await startRoster();
    assert.deepStrictEqual(hs.listCivilianRoster({ maxNames: 3 }), { ok: true, atMs: null, systems: [] });
    hs.noteCivilians(bySystem(), 1);
    hs.noteCivilians(new Map(), 2);
    assert.deepStrictEqual(hs.listCivilianRoster({ maxNames: 3 }).systems, []);
    hs.noteCivilians(bySystem(), 3);
    hs.stop();
    assert.deepStrictEqual(hs.listCivilianRoster({ maxNames: 3 }), { ok: false, reason: "NOT_RUNNING" });
    assert.strictEqual(hs.getStatus().chatter.snapshotSystems, 0, "stop clears the snapshot");
    const stub = createUnavailableHighsecLife("X");
    assert.deepStrictEqual(stub.listCivilianRoster({ maxNames: 3 }), { ok: false, reason: "X" });
    assert.ok(Object.keys(stub).includes("listCivilianRoster"));
  });

  test("R3 name cache: the same map version -> getOwnerIdentity once per slot; a new version -> rebuilt", async () => {
    const { hs, vc } = await startRoster();
    try {
      hs.noteCivilians(bySystem(), 1);
      vc.calls = 0;
      hs.listCivilianRoster({ maxNames: 3 });
      hs.listCivilianRoster({ maxNames: 3 });
      assert.strictEqual(vc.calls, 2, "2 slots, one rebuild");
      vc.version = 2;
      hs.listCivilianRoster({ maxNames: 3 });
      assert.strictEqual(vc.calls, 4, "a new version rebuilds");
    } finally {
      hs.stop();
    }
  });
};
