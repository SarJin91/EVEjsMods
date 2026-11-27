"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { buildBoardRows } = require("../../lib/bounty/view");
const { createBountyService } = require("../../lib/bounty/service");
const { createUnavailableBounty } = require("../../lib/bounty");
const R = require("../../lib/bounty/repository");
const { LEVELS } = require("../../lib/bounty/data/levels");
const { createWanted } = require("../../lib/jobBoard/wanted");
const { buildSnapshot } = require("../../lib/jobBoard/readModel");
const { toWireV1, LEN } = require("../../lib/jobBoard/wire");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const MIN = 60000;

let base = null;
function settings(over = {}) {
  if (!base) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.deepStrictEqual(r.errors || [], []);
    base = r.config.bountyHunters;
  }
  return { ...base, enabled: true, boardEnabled: true, ...over };
}

function fakeGraph() {
  return {
    getSystem: (id) => (Number.isInteger(id) && id >= 1 && id <= 400 ? { id, name: `Sys-${id}`,
      constellationId: 20000000 + Math.ceil(id / 10), regionId: 10000000 + Math.ceil(id / 100), secClass: "nullsec" }
      : null),
    getConstellationName: (c) => (c === 20000007 ? null : `Con-${c - 20000000}`),
    getRegionName: (r) => `Reg-${r - 10000000}`,
    getNeighbors: () => [],
    getSystemIds: () => Array.from({ length: 400 }, (_v, i) => i + 1),
  };
}

function target(i, over = {}) {
  const level = (i % 6) + 1;
  return { wantedId: `bnt:${i}:1`, gangSlot: i, cycle: 1, factionId: 500010, characterId: 90000000 + i, level,
    archetype: "BRAWLER", smuggler: i % 7 === 0 ? 1 : 0, state: "ROAMING", systemId: 400 - (i % 400),
    stayIndex: 1, nextMoveAt: T0, expiresAt: T0 + 86400000, escortsLost: 0, traceSystemId: (i % 400) + 1,
    traceAt: T0 - 120 * MIN, rewardIsk: LEVELS[level].rewardIsk + i, seed: i, payoutState: "NONE", endedAt: null,
    createdAt: T0, updatedAt: T0, version: 1, ...over };
}

module.exports = ({ test, skip }) => {
  test("W1 buildBoardRows on 300 rows: blur, delay, near by jumps (jumps only L1-L2), top without near, more, no nick "
    + "skipped", () => {
    const g = fakeGraph();
    const rows = Array.from({ length: 300 }, (_v, i) => target(i + 1));
    const distances = new Map(Array.from({ length: 20 }, (_v, i) => [i + 1, i]));
    const nickOf = (t) => (t.characterId === 90000013 ? null : `Nick ${t.characterId}`);
    const o = { now: T0, levels: LEVELS, graph: g, nickOf, distances, nearJumps: 8, nearRows: 6, topRows: 5 };
    const out = buildBoardRows(rows, o);
    assert.deepStrictEqual(out.summary, { total: 300, byLevel: [50, 50, 50, 50, 50, 50] });
    assert.deepStrictEqual(out.near.map((r) => [r.nick, r.level, r.jumps, r.seen && r.seen.kind]), [
      ["Nick 90000001", 2, 1, "system"],
      ["Nick 90000002", 3, null, "constellation"],
      ["Nick 90000003", 4, null, "constellation"],
      ["Nick 90000004", 5, null, "region"],
      ["Nick 90000005", 6, null, "region"],
      ["Nick 90000006", 1, 6, "system"]]);
    assert.deepStrictEqual(out.near[0].seen, { kind: "system", name: "Sys-2" });
    assert.deepStrictEqual(out.near[1].seen, { kind: "constellation", name: "Con-1" });
    assert.deepStrictEqual(out.near[3].seen, { kind: "region", name: "Reg-1" });
    assert.strictEqual(out.near[0].ageS, 120 * 60);
    assert.deepStrictEqual(out.near.map((r) => r.systemId), [2, 3, 4, 5, 6, 7]);
    assert.strictEqual(out.top.length, 5);
    assert.ok(out.top.every((r) => r.level === 6 && r.nick !== "Nick 90000005"), JSON.stringify(out.top));
    assert.ok(out.top[0].rewardIsk >= out.top[4].rewardIsk);
    assert.strictEqual(out.more, 300 - 6 - 5);
    const solo = buildBoardRows([target(13, { level: 6, rewardIsk: 999e6 })], o);
    assert.deepStrictEqual([solo.summary.total, solo.top.length, solo.more], [1, 0, 1]);

    const fresh = [target(6, { traceAt: T0 - 4 * MIN }), target(5, { traceAt: T0 - 59 * MIN })];
    const f = buildBoardRows(fresh, o);
    assert.deepStrictEqual([f.near.length, f.top.map((r) => [r.seen, r.ageS, r.jumps])], [0,
      [[null, null, null], [null, null, null]]]);
    const ok = buildBoardRows([target(6, { traceAt: T0 - 5 * MIN })], o);
    assert.deepStrictEqual(ok.near.map((r) => [r.jumps, r.ageS]), [[6, 300]]);
    const none = buildBoardRows([target(1, { traceSystemId: null, traceAt: null }),
      target(2, { traceSystemId: 61 })], o);
    assert.ok(none.top.every((r) => r.seen === null), JSON.stringify(none.top));
    assert.ok([...f.top, ...none.top].every((r) => !("systemId" in r)), JSON.stringify([f.top, none.top]));
    assert.ok(!JSON.stringify(out).includes(`Sys-${rows[0].systemId}"`));
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("W2 bounty listBoardRows on a store", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("W2 boardEnabled off / NOT_READY / stub -> no section; running -> RAM only (no transaction), nick from "
      + "memberNames else the vendor name", () => {
      withStore(driver, (opened) => {
        const seeded = opened.store.transaction("w2.seed", (tx) => {
          for (const slot of [1, 2]) {
            const made = R.createInTx(tx, { slot, cycle: 1, factionId: 500010, characterId: 100 + slot - 1, level: 1,
              archetype: "BRAWLER", smuggler: 0, systemId: 5, nextMoveAt: T0 + 3600000, expiresAt: T0 + 86400000,
              rewardIsk: 3000000 * slot, seed: slot }, T0 - 3600000);
            assert.ok(made.ok, JSON.stringify(made));
            const moved = R.moveInTx(tx, made.target, 6, T0 + 3600000, T0 - 30 * MIN);
            assert.ok(moved.ok, JSON.stringify(moved));
          }
          return { ok: true };
        });
        assert.ok(seeded.ok, JSON.stringify(seeded));
        const spy = [];
        const store = { transaction(name, fn) {
          spy.push(name);
          return opened.store.transaction(name, fn);
        } };
        const vc = { getOwnerIdentity: () => ({ ok: true, state: "LINKED", characterIds: [100, 101],
          memberIndexes: [0, 1], memberNames: ["Red Fang", null], ceoCharacterId: 100, corporationId: 98000001,
          refusedMemberCount: 0 }), countOwnerCharacters: () => ({ ok: true, ready: true, total: 2 }),
        ensureOwnerIdentity: () => ({ ok: true, queued: true }) };
        const make = (P) => createBountyService({ store, worldSeed: 7, settings: P, factionIds: [500010],
          levels: LEVELS, getGraph: () => fakeGraph(), getVirtualCorps: () => vc,
          homeStationOf: () => ({ stationId: 60000001, corporationId: 1000127, systemId: 1 }),
          bloodlinesOf: () => [1], ownerCharacterBudget: 64,
          systemFactionsOf: (ids) => ({ ok: true, entries: ids.map((systemId) => ({ systemId, factionId: 500010 })) }),
          characterNameOf: (id) => (id === 101 ? "Vendor Nick" : null) });
        const P = settings({ maxGangs: 1, gangMembers: 2, maxActive: 2 });
        const wantedOf = (bounty) => createWanted({ ctx: { bounty }, bump() {} });

        const off = make(settings({ ...P, boardEnabled: false }));
        assert.strictEqual(off.boot(T0).ok, true);
        assert.deepStrictEqual(off.listBoardRows({ now: T0, distances: null }),
          { ok: false, reason: "BOUNTY_DISABLED" });
        assert.strictEqual(wantedOf(off).read(null, T0), null);
        const cold = make(P);
        assert.deepStrictEqual(cold.listBoardRows({ now: T0, distances: null }), { ok: false, reason: "NOT_READY" });
        assert.strictEqual(wantedOf(cold).read(null, T0), null);
        for (const why of ["BOUNTY_DISABLED", "BOUNTY_UNAVAILABLE"]) {
          assert.strictEqual(wantedOf(createUnavailableBounty(why)).read(null, T0), null, why);
        }
        assert.strictEqual(wantedOf(undefined).read(null, T0), null);
        assert.deepStrictEqual(wantedOf({ listBoardRows: () => ({ ok: false, reason: "BOARD_FAILED" }) })
          .read(null, T0), { ok: false, reason: "BOARD_FAILED" });

        const svc = make(P);
        assert.strictEqual(svc.boot(T0).ok, true);
        const before = spy.length;
        const r = svc.listBoardRows({ now: T0, distances: new Map([[1, 0], [5, 2]]) });
        assert.deepStrictEqual(spy.slice(before), [], "listBoardRows opens no transaction");
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.deepStrictEqual(r.summary, { total: 2, byLevel: [2, 0, 0, 0, 0, 0] });
        assert.deepStrictEqual(r.near.map((x) => [x.nick, x.jumps, x.seen]), [
          ["Vendor Nick", 2, { kind: "system", name: "Sys-5" }], ["Red Fang", 2, { kind: "system", name: "Sys-5" }]]);
        assert.deepStrictEqual([r.top, r.more], [[], 0]);
        const far = svc.listBoardRows({ now: T0, distances: null });
        assert.deepStrictEqual([far.near, far.top.map((x) => x.nick), far.more], [[], ["Vendor Nick", "Red Fang"], 0]);
        assert.deepStrictEqual(spy.slice(before), [], "still no transaction");
        svc.stop();
        assert.deepStrictEqual(svc.listBoardRows({ now: T0, distances: null }), { ok: false, reason: "NOT_READY" });
      });
    });
  }

  test("W3 toWireV1: wanted ASCII within LEN; without wanted / section off = the wire of before; refusal order", () => {
    const input = (over) => ({ now: T0, viewer: { characterId: 1, systemId: 5 }, jobs: { ok: true, jobs: [] },
      wars: { ok: true, rows: [] }, jumpsOf: () => null, names: { system: () => "Home" },
      limits: { maxJobRows: 5, maxWarRows: 5 }, ...over });
    const ui = { pollMs: 0 };
    const plain = toWireV1(buildSnapshot(input({})), ui);
    assert.ok(!("wanted" in plain));
    assert.deepStrictEqual(Object.keys(plain), ["v", "at", "sys", "sysName", "ui", "jobs", "wars", "more", "refusals"]);
    const offInput = createWanted({ ctx: { bounty: createUnavailableBounty("BOUNTY_DISABLED") }, bump() {} })
      .read(null, T0);
    assert.deepStrictEqual(toWireV1(buildSnapshot(input(offInput ? { wanted: offInput } : {})), ui), plain);

    const long = `Zo${String.fromCharCode(0x0142)}${String.fromCharCode(0x0107)} ${"x".repeat(60)}`;
    const w = toWireV1(buildSnapshot(input({ wanted: { ok: true, summary: { total: 243, byLevel: [70, 60, 50, 30, 20,
      13] }, near: [{ nick: long, level: 1, rewardIsk: 3000000, smuggler: false,
      seen: { kind: "system", name: `Sys ${"y".repeat(60)}` }, ageS: 600, jumps: 3, systemId: 30000142 },
    { nick: "Con Row", level: 3, rewardIsk: 1, smuggler: false, seen: { kind: "constellation", name: "MDM8-J" },
      ageS: 60, jumps: null, systemId: 30000143 },
    { nick: "Bad Sid", level: 4, rewardIsk: 1, smuggler: false, seen: { kind: "region", name: "Delve" }, ageS: 60,
      jumps: null, systemId: 0 }],
    top: [{ nick: "Big One", level: 6, rewardIsk: 600000000, smuggler: true, seen: null, ageS: null, jumps: null,
      systemId: 30000144 }, { nick: "", level: 6, rewardIsk: 1, smuggler: false, seen: null }], more: 241 } })), ui);
    assert.deepStrictEqual(w.wanted.s, [243, 70, 60, 50, 30, 20, 13]);
    assert.strictEqual(w.wanted.m, 241);
    const [n] = w.wanted.n;
    assert.ok(/^[\x20-\x7e]*$/.test(JSON.stringify(w.wanted)), JSON.stringify(w.wanted));
    assert.ok(n.nick.startsWith("Zolc ") && n.nick.length === LEN.nick, n.nick);
    assert.ok(n.seen.length === LEN.seen, n.seen);
    assert.deepStrictEqual([n.lv, n.rw, n.sm, n.kind, n.age, n.j, n.sid], [1, "3.0M ISK", false, "system", 600, 3,
      30000142]);
    assert.deepStrictEqual(w.wanted.n.slice(1).map((x) => [x.kind, x.seen, x.j, x.sid]),
      [["constellation", "MDM8-J", -1, 30000143], ["region", "Delve", -1, -1]]);
    assert.deepStrictEqual(w.wanted.t, [{ nick: "Big One", lv: 6, rw: "600.0M ISK", sm: true, seen: "", kind: "",
      age: -1, j: -1, sid: -1 }], "a row without a nick is dropped; no seen -> sid -1");
    const py = require("node:fs").readFileSync(path.join(MOD_DIR, "client", "board.py"), "utf8");
    assert.ok(py.includes("if kind in ('constellation', 'region'):"), "board.py names the kind");
    assert.ok(py.includes("(_lne_wanted(r), _lne_int(r.get('sid')) if r.get('seen') else -1)"), "board.py sid lines");
    const ts = py.slice(py.indexOf("def text_section("), py.indexOf("def section("));
    for (const needle of ["if system_id > 0:", "available.get('info.ShowInfo')", "self.info_handler(system_id)",
      "self.ui_flag('travel') and available.get('starmap.SetWaypoint')", "self.route_handler(system_id)"]) {
      assert.ok(ts.includes(needle), `text_section ${needle}`);
    }
    const r = toWireV1(buildSnapshot(input({ wanted: { ok: false, reason: "BOARD_FAILED" },
      nearby: { events: { rows: [], refusals: ["events:TX_FAILED"], systemIds: new Set(), truncatedSources: 0 },
        front: { ok: false, reason: "FRONT_DOWN" }, news: null } })), ui);
    assert.deepStrictEqual(r.refusals, ["front:FRONT_DOWN", "wanted:BOARD_FAILED", "events:TX_FAILED"]);
    assert.ok(!("wanted" in r));
  });
};
