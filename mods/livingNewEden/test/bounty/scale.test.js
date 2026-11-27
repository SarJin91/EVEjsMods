"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createBountyService } = require("../../lib/bounty/service");
const { slotLayout, bossOf } = require("../../lib/bounty/plan");
const { LEVELS } = require("../../lib/bounty/data/levels");
const { styleFor } = require("../../lib/names/styles");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const MIN = 60000;
const HOUR = 3600000;
const SIDE = 30;
const HOME = 15 * SIDE + 15 + 1;
const FACTIONS = Object.freeze([500010, 500011, 500012, 500019, 500020]);

let base = null;
function settings(over = {}) {
  if (!base) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.deepStrictEqual(r.errors || [], []);
    base = r.config.bountyHunters;
  }
  return { ...base, enabled: true, ...over };
}

function grid() {
  const idOf = (x, y) => y * SIDE + x + 1;
  return {
    getSystem: (id) => (Number.isInteger(id) && id >= 1 && id <= SIDE * SIDE ? { id,
      secClass: Math.floor(Math.floor((id - 1) / SIDE) / 2) % 2 === 0 ? "lowsec" : "nullsec",
      regionId: 10000001, constellationId: 20000001 } : null),
    getNeighbors: (id) => {
      const x = (id - 1) % SIDE;
      const y = Math.floor((id - 1) / SIDE);
      const out = [];
      if (x > 0) out.push(idOf(x - 1, y));
      if (x < SIDE - 1) out.push(idOf(x + 1, y));
      if (y > 0) out.push(idOf(x, y - 1));
      if (y < SIDE - 1) out.push(idOf(x, y + 1));
      return out;
    },
    getSystemIds: () => Array.from({ length: SIDE * SIDE }, (_v, i) => i + 1),
  };
}
const factionOfId = (id) => FACTIONS[Math.floor(((id - 1) % SIDE) / 6)];
const systemFactionsOf = (ids) => ({ ok: true, entries: ids.map((systemId) => ({ systemId,
  factionId: factionOfId(systemId) })) });

function fakeVc(opts = {}) {
  const vc = { ensures: [], states: new Map(), members: new Map(), total: opts.total || 0,
    getOwnerIdentity(kind, gangId) {
      assert.strictEqual(kind, "outlaw");
      const s = vc.states.has(gangId) ? vc.states.get(gangId) : (opts.linked ? "LINKED" : "PENDING");
      if (s !== "LINKED") return { ok: true, state: s };
      const idx = vc.members.get(gangId) || [0, 1, 2, 3, 4, 5, 6, 7].slice(0, opts.members || 5);
      return { ok: true, state: "LINKED", corporationId: 98000000 + gangId, ceoCharacterId: gangId * 100,
        characterIds: idx.map((n) => gangId * 100 + n), memberIndexes: idx.slice(), refusedMemberCount: 0 };
    },
    ensureOwnerIdentity(spec) {
      vc.ensures.push(spec);
      return { ok: true, queued: true };
    },
    countOwnerCharacters: () => ({ ok: true, ready: true, total: vc.total, byKind: {} }),
  };
  return vc;
}

function service(opened, P, opts = {}) {
  const vc = opts.vc || fakeVc({ linked: true });
  const g = grid();
  const spy = { txs: [], names: [] };
  const store = {
    transaction(name, fn) {
      const t = { name, writes: 0 };
      spy.txs.push(t);
      return opened.store.transaction(name, (db) => fn({ prepare(sql) {
        const st = db.prepare(sql);
        return { get: (...a) => st.get(...a), all: (...a) => st.all(...a),
          run: (...a) => {
            const info = st.run(...a);
            t.writes += Number(info.changes);
            return info;
          } };
      } }));
    },
  };
  const svc = createBountyService({ store, worldSeed: 7, settings: P, factionIds: FACTIONS, levels: LEVELS,
    getGraph: () => g, getVirtualCorps: () => vc,
    homeStationOf: () => ({ stationId: 60000001, corporationId: 1000127, systemId: HOME }),
    bloodlinesOf: () => [1, 2, 11], ownerCharacterBudget: opts.budget || 2048, systemFactionsOf });
  return { svc, vc, spy, g };
}

const allSystems = () => Array.from({ length: SIDE * SIDE }, (_v, i) => i + 1);

function sql(opened, text) {
  const r = opened.store.transaction("bs.sql", (db) => (/^\s*SELECT/i.test(text) ? db.prepare(text).all()
    : db.prepare(text).run().changes));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

module.exports = ({ test, skip }) => {
  test("BS1 slotLayout / bossOf by member index; outlaw nicknames in styleFor", () => {
    const lay = [];
    for (let s = 1; s <= 10; s += 1) {
      const r = slotLayout(s, 5);
      assert.strictEqual(r.ok, true);
      lay.push([r.gangId, r.memberIndex]);
    }
    assert.deepStrictEqual(lay, [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4], [2, 0], [2, 1], [2, 2], [2, 3], [2, 4]]);
    assert.deepStrictEqual(slotLayout(0, 5), { ok: false, reason: "INVALID_INPUT" });
    const idn = { ok: true, state: "LINKED", characterIds: [901, 902, 904], memberIndexes: [0, 1, 3] };
    assert.deepStrictEqual(bossOf(idn, 2), { ok: false, reason: "MEMBER_PENDING" });
    assert.deepStrictEqual(bossOf(idn, 3), { ok: true, characterId: 904 }, "member 3, not position 2");
    assert.deepStrictEqual(bossOf({ ok: true, state: "PENDING" }, 0), { ok: false, reason: "NOT_LINKED" });
    assert.strictEqual(styleFor({ raceId: 1, ownerKind: "outlaw" }).nicknames, true);
    assert.strictEqual(styleFor({ raceId: 1, ownerKind: "outlaw" }).style, "caldari");
    assert.strictEqual(styleFor({ raceId: 1, ownerKind: "free" }).nicknames, false);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("BS2-BS5 bounty scale on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("BS2 passes up to maxActive within the row budget of a transaction; no work -> no transaction", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const { svc, spy } = service(opened, P);
      assert.strictEqual(svc.boot(T0).ok, true);
      const bound = P.movesPerPass + P.createsPerPass + P.prunePerRun;
      let t = T0;
      for (let i = 0; i < 200 && svc.getStatus().active < P.maxActive; i += 1) {
        t += 5000;
        const r = svc.runPass(t);
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.ok((r.created || 0) <= P.createsPerPass);
      }
      const st = svc.getStatus();
      assert.strictEqual(st.active, P.maxActive);
      assert.strictEqual(st.slots, 300);
      assert.strictEqual(st.targets.length, P.statusMaxTargets);
      assert.strictEqual(Object.values(st.census.byState).reduce((a, b) => a + b, 0), P.maxActive);
      for (const tx of spy.txs) assert.ok(tx.writes <= bound, `${tx.name} wrote ${tx.writes} > ${bound}`);
      assert.strictEqual(spy.txs.filter((x) => x.name === "bounty.pass").length, Math.ceil(P.maxActive / 4));
      const bosses = sql(opened, "SELECT character_id AS c FROM world_bounty_targets").map((x) => x.c);
      assert.strictEqual(new Set(bosses).size, bosses.length);
      const before = spy.txs.length;
      const idle = svc.runPass(t + 5000);
      assert.deepStrictEqual([idle.ok, idle.idle], [true, true]);
      assert.strictEqual(spy.txs.length, before, "no store.transaction");
      assert.ok(svc.getStatus().counters.idle >= 1);
    });
  });

  test("BS3 300 targets, +48 h: catch-up by movesPerPass, one write per row; a second service builds the same RAM",
    () => {
      withStore(driver, (opened) => {
        const P = settings({ maxActive: 300 });
        const a = service(opened, P);
        assert.strictEqual(a.svc.boot(T0).ok, true);
        let t = T0;
        for (let i = 0; i < 200 && a.svc.getStatus().active < 300; i += 1) a.svc.runPass((t += 5000));
        assert.strictEqual(a.svc.getStatus().active, 300);
        const ramCensus = (x) => {
          const { territory: _t, ...rest } = x.svc.getStatus().census;
          return rest;
        };
        const same = (x, y) => {
          assert.deepStrictEqual(ramCensus(x), ramCensus(y));
          assert.deepStrictEqual(x.svc.residentsFor(allSystems(), t), y.svc.residentsFor(allSystems(), t));
        };
        const b = service(opened, P);
        assert.strictEqual(b.svc.boot(t).ok, true);
        same(a, b);
        t += 48 * HOUR;
        let passes = 0;
        for (;;) {
          const r = a.svc.runPass(t);
          assert.strictEqual(r.ok, true, JSON.stringify(r));
          if (r.idle || (r.expired + r.moved + r.held === 0)) break;
          assert.ok(r.expired + r.moved + r.held <= P.movesPerPass, JSON.stringify(r));
          assert.strictEqual(r.created, 0, "slots cool down 1 h after expiry");
          passes += 1;
          assert.ok(passes <= 40, "catch-up ends");
        }
        assert.strictEqual(passes, Math.ceil(300 / P.movesPerPass));
        const versions = sql(opened, "SELECT version AS v FROM world_bounty_targets").map((x) => x.v);
        assert.strictEqual(versions.length, 300);
        assert.ok(versions.every((v) => v === 2), "one move / expiry per row");
        const c = service(opened, P);
        assert.strictEqual(c.svc.boot(t).ok, true);
        same(a, c);
      });
    });

  test("BS4 ensure pacing: one gang in progress, noBudget, a LINKED gang with missing members ensured again", () => {
    withStore(driver, (opened) => {
      const P = settings({ maxGangs: 3 });
      const vc = fakeVc();
      const { svc } = service(opened, P, { vc });
      svc.boot(T0);
      svc.runPass(T0 + 1000);
      assert.deepStrictEqual(vc.ensures.map((s) => [s.ownerId, s.members]), [[1, 5]]);
      svc.runPass(T0 + 2000);
      assert.strictEqual(vc.ensures.length, 1, "maxEnsuringGangs 1");
      assert.ok(svc.getStatus().counters.ensureDeferred >= 1);
      vc.states.set(1, "LINKED");
      svc.runPass(T0 + 3000);
      assert.deepStrictEqual(vc.ensures.map((s) => s.ownerId), [1, 2]);
      svc.runPass(T0 + 3000 + P.ensureStaleMs);
      assert.deepStrictEqual(vc.ensures.map((s) => s.ownerId), [1, 2, 3]);
    });
    withStore(driver, (opened) => {
      const P = settings({ maxGangs: 3 });
      const vc = fakeVc({ total: 1000 - 2 });
      const { svc } = service(opened, P, { vc, budget: 1000 });
      svc.boot(T0);
      svc.runPass(T0 + 1000);
      assert.deepStrictEqual(vc.ensures, []);
      assert.ok(svc.getStatus().counters.noBudget >= 1);
    });
    withStore(driver, (opened) => {
      const P = settings({ maxGangs: 1 });
      const vc = fakeVc();
      vc.states.set(1, "LINKED");
      vc.members.set(1, [0, 1, 2]);
      const { svc } = service(opened, P, { vc });
      svc.boot(T0);
      const r = svc.runPass(T0 + 1000);
      assert.strictEqual(r.created, 3, JSON.stringify(r));
      assert.ok(svc.getStatus().counters.memberPending >= 2);
      assert.deepStrictEqual(vc.ensures.map((s) => [s.ownerId, s.members]), [[1, 5]]);
      assert.strictEqual(svc.getStatus().linkedSlots, 3);
    });
  });

  test("BS5 cooldowns: EXPIRED after respawnCooldownMs, KILLED after killedCooldownMs; oldest readyAt first", () => {
    withStore(driver, (opened) => {
      const P = settings({ maxGangs: 1, gangMembers: 2, maxActive: 2 });
      const a = service(opened, P);
      a.svc.boot(T0);
      assert.strictEqual(a.svc.runPass(T0 + 1000).created, 2);
      const t1 = T0 + 2 * HOUR;
      sql(opened, `UPDATE world_bounty_targets SET state = 'KILLED', ended_at = ${t1}, version = version + 1 `
        + "WHERE gang_slot = 1");
      sql(opened, `UPDATE world_bounty_targets SET state = 'EXPIRED', ended_at = ${t1}, version = version + 1 `
        + "WHERE gang_slot = 2");
      const b = service(opened, P);
      b.svc.boot(t1);
      const cycles = () => sql(opened, "SELECT wanted_id AS id FROM world_bounty_targets ORDER BY wanted_id")
        .map((x) => x.id);
      b.svc.runPass(t1 + P.respawnCooldownMs - 1);
      assert.deepStrictEqual(cycles(), ["bnt:1:1", "bnt:2:1"]);
      b.svc.runPass(t1 + P.respawnCooldownMs);
      assert.deepStrictEqual(cycles(), ["bnt:1:1", "bnt:2:1", "bnt:2:2"], "EXPIRED back after 1 h");
      b.svc.runPass(t1 + P.killedCooldownMs - 1);
      assert.strictEqual(cycles().length, 3, "KILLED waits 12 h");
      b.svc.runPass(t1 + P.killedCooldownMs);
      assert.deepStrictEqual(cycles(), ["bnt:1:1", "bnt:1:2", "bnt:2:1", "bnt:2:2"]);
    });
    withStore(driver, (opened) => {
      const P = settings({ maxGangs: 1, gangMembers: 2, maxActive: 2, createsPerPass: 1 });
      const a = service(opened, P);
      a.svc.boot(T0);
      a.svc.runPass(T0 + 1000);
      a.svc.runPass(T0 + 2000);
      const t1 = T0 + 2 * HOUR;
      sql(opened, `UPDATE world_bounty_targets SET state = 'EXPIRED', ended_at = ${t1 + 10 * MIN}, `
        + "version = version + 1 WHERE gang_slot = 1");
      sql(opened, `UPDATE world_bounty_targets SET state = 'EXPIRED', ended_at = ${t1}, version = version + 1 `
        + "WHERE gang_slot = 2");
      const b = service(opened, { ...P, maxActive: 1 });
      b.svc.boot(t1 + 3 * HOUR);
      b.svc.runPass(t1 + 3 * HOUR);
      const made = sql(opened, "SELECT wanted_id AS id FROM world_bounty_targets WHERE state = 'ROAMING'");
      assert.deepStrictEqual(made.map((x) => x.id), ["bnt:2:2"]);
    });
  });

  test("BS6: a gang PENDING for ever does not block the others; a store fault is retried; blocked slots idle",
    () => {
      withStore(driver, (opened) => {
        const P = settings({ maxGangs: 3 });
        const vc = fakeVc();
        const { svc } = service(opened, P, { vc });
        svc.boot(T0);
        for (let k = 0; k < 4; k += 1) svc.runPass(T0 + 1000 + k * P.ensureStaleMs);
        assert.deepStrictEqual(vc.ensures.map((s) => s.ownerId), [1, 2, 3, 1]);
      });
      withStore(driver, (opened) => {
        const P = settings({ maxGangs: 2 });
        const vc = fakeVc();
        const asked = [];
        vc.ensureOwnerIdentity = (spec) => {
          asked.push(spec.ownerId);
          return spec.ownerId === 1 ? { ok: false, reason: "TX_FAILED" } : { ok: true, queued: true };
        };
        const { svc } = service(opened, P, { vc });
        svc.boot(T0);
        svc.runPass(T0 + 1000);
        svc.runPass(T0 + 2000);
        assert.deepStrictEqual(asked, [1, 2]);
        assert.deepStrictEqual(svc.getStatus().gangs.refused, []);
        svc.runPass(T0 + 3000 + P.ensureStaleMs);
        assert.deepStrictEqual(asked, [1, 2, 1], "gang 1 retried");
      });
      withStore(driver, (opened) => {
        const P = settings({ maxGangs: 1, maxActive: 5 });
        const vc = fakeVc();
        vc.states.set(1, "REFUSED");
        const { svc, spy } = service(opened, P, { vc });
        svc.boot(T0);
        svc.runPass(T0 + 1000);
        const pending = svc.getStatus().counters.memberPending;
        const txs = spy.txs.length;
        const r = svc.runPass(T0 + 2000);
        assert.deepStrictEqual([r.ok, r.idle], [true, true]);
        assert.strictEqual(spy.txs.length, txs, "no transaction");
        assert.strictEqual(svc.getStatus().counters.memberPending, pending);
        assert.deepStrictEqual(vc.ensures, []);
      });
    });
};
