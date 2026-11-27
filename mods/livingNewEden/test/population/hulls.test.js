"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { resolveConfig } = config;
const { settingsOf, STATE, INTENT, ARCHETYPE } = require("../../lib/population/schema");
const { ARCHETYPES } = require("../../lib/population/data/archetypes");
const HP = require("../../lib/population/data/hullPools");
const rules = require("../../lib/population/rules");
const { createRng } = require("../../lib/util/rng");
const { buildPopulationPanel } = require("../../lib/population/view");
const CIV = require("../../lib/adapter/data/civilianLiveProfiles");
const fp = require("../../lib/adapter/factionProfiles");
const DATA = require("../../lib/adapter/data/factionLiveProfiles");
const { readTypeLooksFrom, MAX_TYPE_IDS } = require("../../lib/adapter/itemTypeFacts");
const { createAdapter } = require("../../lib/adapter");
const { civilianProfilesByRole, pilotHullProfilesOf, verifyPilotHulls } = require("../../lib/highsecLife/traffic/plan");
const loader = require("../../loader");
const { findCompose } = require("../config/composeKeys.test");
const { rig: G } = require("./groups.test");
const { rig: TP } = require("../highsecLife/trafficPilots.test");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const { NOW, SYS } = G;
const OBELISK = 20187;
const CHARON = 20185;
const BADGER = 648;
const ORCA = 28606;
const FREIGHTERS = [CHARON, OBELISK];
const KEYS = ["EVEJS_LNE_POPULATION_HULLS_ENABLED", "EVEJS_LNE_POPULATION_HULLS_RESTRICTED_AVOID_SEC_CLASSES"];

const hullsOn = (over) => ({ hulls: { enabled: true, ...(over || {}) } });

function recordingGraph() {
  const g = F.fakeGraph();
  const inner = g.findRoute;
  const calls = [];
  g.findRoute = (from, to, c) => {
    calls.push({ from, to, c });
    const dest = g.getSystem(to);
    if (c && Array.isArray(c.avoidSecClasses) && dest && c.avoidSecClasses.includes(dest.secClass)) {
      return { ok: false, reason: "UNREACHABLE", detail: "DESTINATION_EXCLUDED" };
    }
    return inner(from, to, c);
  };
  g.calls = calls;
  return g;
}

const dbOf = (rows) => ({ rows: new Map(rows.map((r) => [r.pilot_id, r])),
  meta: { rules_version: 1, size: rows.length, seeded_at: 1, flushed_at: 1 } });

function looksOf(over = {}) {
  const looks = new Map();
  for (const e of pilotHullProfilesOf(CIV.civilianDataOf({ pilotHulls: true })).values()) {
    looks.set(e.shipTypeId, { typeId: e.shipTypeId, graphicID: e.shipTypeId, categoryID: 6 });
    looks.set(e.presentationTypeId, { typeId: e.presentationTypeId, graphicID: e.shipTypeId, categoryID: 11 });
  }
  for (const [id, look] of Object.entries(over)) looks.set(Number(id), { typeId: Number(id), ...look });
  return looks;
}

function hullHarness(pop, readTypeLooks) {
  return TP.harness({ pop, extra: { populationLive: { settings: TP.LIVE_ON, getPopulation: () => pop,
    leaseOf: () => ({ ok: true, characterId: null }),
    hullProfiles: pilotHullProfilesOf(CIV.civilianDataOf({ pilotHulls: true })), readTypeLooks } } });
}

const spawnSpecs = (h) => h.log.filter((e) => e[0] === "spawn").map((e) => e[1]);
const pilotCand = (pilotId, shipTypeId, role = "HAULER") => ({ ...TP.cand(pilotId, role, "GATE", TP.FROM, TP.NEXT),
  shipTypeId });

module.exports = ({ test }) => {
  test("HP1 data: pools in HULL_TYPES, live <=> lne_civ_* row, FAR only = FRIGATE/CRUISER/ORCA, PILOT rows last", () => {
    for (const [a, byBand] of Object.entries(HP.POOLS)) {
      for (const [band, ids] of Object.entries(byBand)) {
        for (const id of ids) assert.ok(Object.prototype.hasOwnProperty.call(HP.HULL_TYPES, id), `${a}/${band}/${id}`);
        if (band === "nullsec") assert.ok(!ids.some((id) => FREIGHTERS.includes(id)), `freighter in ${a}/nullsec`);
        assert.ok(ids.some((id) => !HP.isRouteRestricted(id)), `only restricted hulls in ${a}/${band}`);
      }
    }
    const classes = new Set(Object.values(HP.HULL_TYPES).map((t) => t.cls));
    assert.deepStrictEqual(HP.HULL_CLASS_NAMES.filter((n, i) => !classes.has(i + 1)), []);
    const rowHulls = new Map([...CIV.CIVILIAN_HULLS.filter((h) => !h.roles.includes("POD")), ...CIV.PILOT_HULLS]
      .map((h) => [h.shipTypeId, h]));
    for (const [id, t] of Object.entries(HP.HULL_TYPES)) assert.strictEqual(t.live, rowHulls.has(Number(id)), id);
    const farOnly = new Set(Object.values(HP.HULL_TYPES).filter((t) => !t.live).map((t) => HP.HULL_CLASS_NAMES[t.cls - 1]));
    assert.deepStrictEqual([...farOnly].sort(), ["CRUISER", "FRIGATE", "ORCA"]);
    for (const h of CIV.PILOT_HULLS) {
      assert.deepStrictEqual(h.roles, ["PILOT"]);
      assert.notStrictEqual(h.presentationTypeId, h.shipTypeId, h.key);
    }
    const civOn = CIV.civilianDataOf({ pilotHulls: true });
    assert.strictEqual(CIV.civilianDataOf({ pilotHulls: true }), civOn, "one frozen copy");
    assert.deepStrictEqual(civilianProfilesByRole(civOn), civilianProfilesByRole(CIV));
    const today = fp.buildFactionProfileRows({ data: DATA, civilianRows: true, civilianData: CIV });
    const withPilots = fp.buildFactionProfileRows({ data: DATA, civilianRows: true, civilianData: civOn });
    assert.ok(today.ok && withPilots.ok);
    const n = today.rows.npcProfiles.length;
    assert.deepStrictEqual(withPilots.rows.npcProfiles.slice(0, n), [...today.rows.npcProfiles]);
    assert.deepStrictEqual(withPilots.rows.npcProfiles.slice(n).map((r) => [r.profileID, r.shipTypeID,
      r.presentationTypeID]), [["lne_civ_nestor", 33472, 57799], ["lne_civ_hurricane", 24702, 46080],
      ["lne_civ_obelisk", 20187, 53569], ["lne_civ_charon", 20185, 53561]]);
    const ids = new Set();
    for (const e of pilotHullProfilesOf(civOn).values()) ids.add(e.shipTypeId).add(e.presentationTypeId);
    assert.ok(ids.size <= MAX_TYPE_IDS, String(ids.size));

    const CATALOG = path.join(path.sep, "x", "server", "src", "space", "npc", "capitals", "capitalNpcCatalog");
    const PARENT = { filename: path.join(path.sep, "x", "server", "src", "space", "npc", "npcData.js") };
    const logger = { log() {}, logError() {}, debug() {} };
    const rowsWith = (population) => {
      const catalogExports = { getCapitalNpcGeneratedRows: (t) => (t === "npcProfiles" ? [] : []) };
      const moduleApi = { _cache: {}, _load: (request) => (request === CATALOG ? catalogExports : {}) };
      const ctx = { state: {}, logger, loadConfig: () => ({ ok: true, sources: {}, warnings: [], errors: [],
        config: { enabled: true, debug: false, dataDir: "/x",
          modules: { materialization: { enabled: false }, world: { enabled: true } },
          materialization: { capitalLiveEnabled: false, factionProfilesEnabled: false },
          bountyHunters: { enabled: false, smugglerEnabled: false },
          highsecLife: { enabled: true, civilianHullsEnabled: true }, population } }) };
      loader.installModuleHook(moduleApi, loader.buildHooks(ctx), logger);
      moduleApi._load(CATALOG, PARENT);
      return catalogExports.getCapitalNpcGeneratedRows("npcProfiles").map((r) => r.profileID);
    };
    try {
      fp._resetForTest();
      const off = rowsWith({ enabled: true, hulls: { enabled: false } });
      fp._resetForTest();
      const on = rowsWith({ enabled: true, hulls: { enabled: true } });
      assert.deepStrictEqual(off, CIV.CIVILIAN_HULLS.map((h) => `lne_civ_${h.key}`));
      assert.deepStrictEqual(on, [...off, "lne_civ_nestor", "lne_civ_hurricane", "lne_civ_obelisk", "lne_civ_charon"]);
    } finally {
      fp._resetForTest();
    }
  });

  test("HP2 freighter: avoidSecClasses in both route searches, nullsec destination = NO_ROUTE, no group without it",
    async () => {
      const rows = [];
      for (let id = 1; id <= 12; id += 1) {
        const at = id <= 6 ? SYS : F.sid(1);
        rows.push(G.row(id, { archetype: ARCHETYPE.TRADER, system_id: at, home_id: at, ship_type_id: id <= 6 ? OBELISK
          : BADGER, seq: id, due_at: NOW }));
      }
      rows.push(G.row(13, { archetype: ARCHETYPE.TRADER, ship_type_id: OBELISK, dest_id: F.sid(11),
        intent: INTENT.TRAVEL, state: STATE.TRAVEL, due_at: NOW }));
      const graph = recordingGraph();
      const { svc } = await G.service(F.settings(G.base({ size: 13, ...hullsOn() })), G.memStore(dbOf(rows)), { graph });
      svc.runPass(NOW);
      const restricted = graph.calls.filter((c) => c.from === SYS);
      const plain = graph.calls.filter((c) => c.from === F.sid(1));
      assert.ok(restricted.length >= 2 && plain.length >= 1, JSON.stringify(graph.calls.map((c) => [c.from, c.to])));
      assert.deepStrictEqual(restricted[0].c, { maxJumps: 12, avoidSecClasses: ["nullsec"] });
      assert.ok(restricted.every((c) => c.c === restricted[0].c), "one frozen restriction object");
      assert.ok(plain.every((c) => c.c === plain[0].c));
      assert.deepStrictEqual(plain[0].c, { maxJumps: 12 });
      assert.ok(restricted.some((c) => c.to === F.sid(11)));
      assert.notStrictEqual(svc.pilot(13).state, "TRAVEL", JSON.stringify(svc.pilot(13)));
      const c = svc.getStatus().counters;
      assert.strictEqual(c["hulls.restrictedRoutes"], restricted.length);
      assert.ok(c.noRoute >= 1);
      svc.stop();

      for (let seq = 0; seq < 80; seq += 1) {
        const g = dbOf([G.row(1, { archetype: ARCHETYPE.TRADER, ship_type_id: BADGER, seq, due_at: NOW }),
          G.row(2, { archetype: ARCHETYPE.TRADER, ship_type_id: OBELISK }),
          G.row(3, { archetype: ARCHETYPE.TRADER, ship_type_id: BADGER })]);
        const s = (await G.service(F.settings(G.base({ size: 3, ...hullsOn(),
          groups: G.groupsOn({ minMembers: 1, maxSize: 3 }) })), G.memStore(g))).svc;
        s.runPass(NOW);
        const st = s.getStatus();
        s.stop();
        if (st.counters["groups.formed"] !== 1) continue;
        assert.deepStrictEqual([st.counters["hulls.groupRefused"], s.pilot(2).groupId, s.pilot(3).groupId],
          [1, undefined, 1]);
        return;
      }
      throw new Error("no seq forms a group");
    });

  test("HP3 pools at seed / RESHIP / POD by the home band, census = recount, panel section only with the flag",
    async () => {
      const S = F.settings(G.base({ size: 200, seedRowsPerSlice: 500, flushRowsPerSlice: 400, maxRoutesPerPass: 5000,
        ...hullsOn() }));
      const T = F.table(S);
      const { svc } = await G.service(S, G.memStore());
      const poolOf = (v) => HP.hullPoolOf(ARCHETYPE[v.archetype], T.bandOf(v.homeId));
      const check = () => {
        for (let id = 1; id <= 200; id += 1) {
          const v = svc.pilot(id);
          assert.ok(poolOf(v).includes(v.shipTypeId), JSON.stringify(v));
          if (T.bandOf(v.homeId) === "nullsec") assert.ok(!FREIGHTERS.includes(v.shipTypeId), JSON.stringify(v));
        }
      };
      check();
      for (let i = 0; i < 60; i += 1) svc.runPass(NOW + i * 600000);
      check();
      const counts = Object.fromEntries(["UNKNOWN", ...HP.HULL_CLASS_NAMES].map((n) => [n, 0]));
      for (let id = 1; id <= 200; id += 1) {
        const cls = HP.hullClassOf(svc.pilot(id).shipTypeId);
        counts[cls === 0 ? "UNKNOWN" : HP.HULL_CLASS_NAMES[cls - 1]] += 1;
      }
      const st = svc.getStatus();
      assert.deepStrictEqual({ ...st.hulls.byClass }, counts);
      assert.strictEqual(Object.values(st.hulls.byClass).reduce((s, n) => s + n, 0), st.size);
      assert.strictEqual(st.hulls.routeRestricted, counts.FREIGHTER);
      const panel = buildPopulationPanel({ service: svc, settings: S, clock: { now: () => NOW } }).getData();
      assert.deepStrictEqual(panel.hulls, { byClass: st.hulls.byClass, noLiveProfile: 0 });
      svc.stop();
      const off = (await G.service(F.settings(G.base({ size: 20 })), G.memStore())).svc;
      const offPanel = buildPopulationPanel({ service: off, settings: S, clock: { now: () => NOW } }).getData();
      assert.ok(!("hulls" in offPanel) && !("hulls" in off.getStatus()));
      off.stop();

      const S1 = F.settings(G.base({ ...hullsOn(), context: { reshipTierEverySeq: 1 } }));
      const home = F.sid(11);
      const p = { pilotId: 1, systemId: home, prevId: 0, destId: 0, homeId: home, shipTypeId: 1944,
        archetype: ARCHETYPE.TRADER, intent: INTENT.DOCK, state: STATE.DOCKED, seq: 50, sinceAt: NOW, dueAt: NOW,
        flags: 0 };
      const cx = { hourPermille: () => 1000, dangerOf: () => 0, hasBelts: () => true, attracts: () => false,
        attractList: () => [] };
      const pool = HP.hullPoolOf(ARCHETYPE.TRADER, "nullsec");
      const reships = { plain: 0, context: 0 };
      for (let seed = 1; seed <= 400; seed += 1) {
        for (const [kind, opts] of [["plain", undefined], ["context", { context: cx }]]) {
          const r = rules.rollIntent(p, T, S1, createRng(seed), () => ({ ok: false, reason: "NO_ROUTE" }), NOW, opts);
          if (!r.ok || r.next.intent !== INTENT.RESHIP) continue;
          reships[kind] += 1;
          assert.ok(pool.includes(r.next.shipTypeId), `${kind} ${r.next.shipTypeId}`);
        }
        const pod = rules.podRespawn({ ...p, state: STATE.POD }, S1, createRng(seed), NOW, T).next.shipTypeId;
        assert.ok(pool.includes(pod), String(pod));
      }
      assert.ok(reships.plain > 0 && reships.context > 0, JSON.stringify(reships));

      const hs = { ...p, homeId: F.sid(1), systemId: F.sid(11) };
      const safe = HP.hullPoolOf(ARCHETYPE.TRADER, "highsec").filter((h) => !FREIGHTERS.includes(h));
      const away = { plain: 0, context: 0, freighterAtHome: 0 };
      for (let seed = 1; seed <= 400; seed += 1) {
        for (const [kind, opts] of [["plain", undefined], ["context", { context: cx }]]) {
          const rngA = createRng(seed);
          const rngH = createRng(seed);
          const r = rules.rollIntent(hs, T, S1, rngA, () => ({ ok: false, reason: "NO_ROUTE" }), NOW, opts);
          const h = rules.rollIntent({ ...hs, systemId: F.sid(1) }, T, S1, rngH, () => ({ ok: false, reason: "NO_ROUTE" }),
            NOW, opts);
          if (!r.ok || r.next.intent !== INTENT.RESHIP) continue;
          away[kind] += 1;
          assert.ok(safe.includes(r.next.shipTypeId), `${kind} ${r.next.shipTypeId}`);
          assert.strictEqual(h.next.intent, INTENT.RESHIP);
          if (FREIGHTERS.includes(h.next.shipTypeId)) away.freighterAtHome += 1;
          assert.strictEqual(rngA.nextFloat(), rngH.nextFloat(), `${kind} seed ${seed}: draws differ`);
        }
      }
      assert.ok(away.plain > 0 && away.context > 0 && away.freighterAtHome > 0, JSON.stringify(away));
      assert.deepStrictEqual(HP.routeSafePool(FREIGHTERS, "nullsec", ["nullsec"]), []);
      assert.strictEqual(HP.routeSafePool(FREIGHTERS, "highsec", ["nullsec"]), FREIGHTERS);
      const S2 = F.settings(G.base({ ...hullsOn({ restrictedAvoidSecClasses: "lowsec,nullsec" }) }));
      assert.deepStrictEqual([...S2.hulls.avoidSecClasses], ["lowsec", "nullsec"]);
      const ls = { ...p, homeId: F.sid(8), systemId: F.sid(8), shipTypeId: BADGER, state: STATE.POD };
      for (let seed = 1; seed <= 200; seed += 1) {
        const pod = rules.podRespawn(ls, S2, createRng(seed), NOW, T).next.shipTypeId;
        assert.ok(!FREIGHTERS.includes(pod) && HP.hullPoolOf(ARCHETYPE.TRADER, "lowsec").includes(pod), String(pod));
      }
      const T2 = F.table(S2);
      let lowTraders = 0;
      for (let id = 1; id <= 300; id += 1) {
        const { row } = rules.seedPilot(id, 7, T2, S2, NOW);
        if (T2.bandOf(row.homeId) === "highsec") continue;
        assert.ok(!FREIGHTERS.includes(row.shipTypeId), JSON.stringify(row));
        if (T2.bandOf(row.homeId) === "lowsec" && row.archetype === ARCHETYPE.TRADER) lowTraders += 1;
      }
      assert.ok(lowTraders > 0, "no lowsec trader seeded");
    });

  test("HP4 LIVE: the profile of the hull, the look check, FAR-only hull no candidate; vendor facts, readTypeLooksFrom",
    async () => {
      let reads = 0;
      const pop = TP.fakePopulation([pilotCand(1, OBELISK)]);
      const h = hullHarness(pop, (ids) => {
        reads += 1;
        return { ok: true, looks: looksOf(), missing: [], ids };
      });
      h.tick();
      assert.deepStrictEqual(spawnSpecs(h).map((s) => s.profileId), ["lne_civ_obelisk"]);
      const st = h.traffic.status();
      assert.deepStrictEqual([st.counters.pilotHullFallback, st.counters.pilotSpawned, reads, st.pilotHulls.verified,
        st.pilotHulls.live, st.pilotHulls.rejected], [0, 1, 1, true, 18, []]);

      const pop2 = TP.fakePopulation([pilotCand(2, 24702), pilotCand(3, BADGER)]);
      const h2 = hullHarness(pop2, () => ({ ok: true, looks: looksOf({ 46080: { graphicID: 1, categoryID: 11 } }),
        missing: [] }));
      h2.tick();
      const c2 = h2.traffic.status().counters;
      assert.deepStrictEqual([c2.pilotHullLookRejected, c2.pilotNoLiveProfile, pop2.calls.claim],
        [1, 1, [3]]);
      assert.deepStrictEqual(h2.traffic.status().pilotHulls.rejected, [24702]);
      assert.deepStrictEqual(spawnSpecs(h2).map((s) => s.profileId), ["lne_civ_badger"]);

      let calls = 0;
      const pop3 = TP.fakePopulation([pilotCand(4, OBELISK), pilotCand(5, CHARON)]);
      const h3 = hullHarness(pop3, () => {
        calls += 1;
        return calls === 1 ? { ok: false, reason: "ITEM_TYPES_UNAVAILABLE" } : { ok: true, looks: looksOf(), missing: [] };
      });
      h3.tick();
      assert.deepStrictEqual([calls, h3.traffic.status().counters.pilotHullsUnverified, pop3.calls.claim.length],
        [1, 1, 0]);
      for (let i = 0; i < 10 && pop3.calls.claim.length === 0; i += 1) h3.tick();
      assert.deepStrictEqual([calls, pop3.calls.claim], [2, [4, 5]]);
      assert.deepStrictEqual(spawnSpecs(h3).map((s) => s.profileId), ["lne_civ_obelisk", "lne_civ_charon"]);

      const rows = [G.row(1, { archetype: ARCHETYPE.MINER, ship_type_id: ORCA, system_id: F.sid(2), dest_id: SYS,
        intent: INTENT.TRAVEL, state: STATE.TRAVEL, due_at: NOW }), G.row(2, { archetype: ARCHETYPE.TRADER,
        ship_type_id: BADGER, system_id: F.sid(2), dest_id: SYS, intent: INTENT.TRAVEL, state: STATE.TRAVEL,
        due_at: NOW })];
      const { svc } = await G.service(F.settings(G.base({ size: 2, near: { enabled: true, attractPermille: 0 },
        live: { trafficEnabled: true }, ...hullsOn() })), G.memStore(dbOf(rows)), { deps: (graph) => ({
        getPresence: () => G.presenceOf(graph, [SYS]), liveMaxOwned: 4 }) });
      svc.runPass(NOW);
      assert.deepStrictEqual([svc.pilot(1).systemId, svc.pilot(2).systemId], [SYS, SYS]);
      assert.deepStrictEqual(svc.liveCandidatesIn(SYS, NOW - 60000, 10).map((c) => c.pilotId), [2]);
      assert.strictEqual(svc.getStatus().counters["hulls.noLiveProfile"], 1);
      svc.stop();

      const reg = fs.readFileSync(path.join(SERVER_SRC, "services", "inventory", "itemTypeRegistry.js"), "utf8");
      const norm = reg.slice(reg.indexOf("function normalizeEntry("), reg.indexOf("function addEntry("));
      assert.ok(/categoryID: Number\(entry\.categoryID\)/.test(norm) && /graphicID: Number\.isFinite/.test(norm), norm);
      const pres = fs.readFileSync(path.join(SERVER_SRC, "space", "npc", "npcPresentation.js"), "utf8");
      const slim = pres.slice(pres.indexOf("function buildNpcSlimPresentation("));
      assert.ok(/resolveItemByTypeID\(presentationTypeID\)/.test(slim) && /: fallbackTypeID,/.test(slim));

      const fake = { resolveItemByTypeID: (id) => (id === 7 ? null : id === 9 ? { graphicID: NaN, categoryID: 11 }
        : { graphicID: id * 10, categoryID: 6 }) };
      const r = readTypeLooksFrom(fake, [5, 7, 9, 5]);
      assert.deepStrictEqual([r.ok, [...r.looks.values()], r.missing], [true, [{ typeId: 5, graphicID: 50,
        categoryID: 6 }, { typeId: 9, graphicID: null, categoryID: 11 }], [7]]);
      assert.deepStrictEqual(readTypeLooksFrom(fake, Array.from({ length: 65 }, (_, i) => i + 1)),
        { ok: false, reason: "ITEM_TYPES_INVALID", detail: "typeIds" });
      assert.strictEqual(readTypeLooksFrom({ resolveItemByTypeID: () => {
        throw new Error("boom");
      } }, [1]).reason, "ITEM_TYPES_FAILED");
      assert.deepStrictEqual(readTypeLooksFrom(null, [1]), { ok: false, reason: "ITEM_TYPES_UNAVAILABLE" });
      const adapter = createAdapter({ moduleApi: { _cache: {} } });
      assert.strictEqual(typeof adapter.readTypeLooks, "function");
      assert.strictEqual(adapter.readTypeLooks([1]).ok, false);
      const entries = pilotHullProfilesOf(CIV.civilianDataOf({ pilotHulls: true }));
      const v = verifyPilotHulls(entries, looksOf({ 53569: { graphicID: OBELISK, categoryID: 6 } }));
      assert.deepStrictEqual([v.verified.size, v.rejected], [entries.size - 1, [OBELISK]]);
    });

  test("HP5 flag off bit for bit (pools, routes, traffic, civilianDataOf) and config (2 keys, W257, W258)", async () => {
    const { hulls: _drop, ...population } = F.populationConfig(G.base({ size: 120, seedRowsPerSlice: 200,
      flushRowsPerSlice: 400, maxRoutesPerPass: 5000 }));
    const runs = [];
    for (const S of [settingsOf({ population }), F.settings(G.base({ size: 120, seedRowsPerSlice: 200,
      flushRowsPerSlice: 400, maxRoutesPerPass: 5000, hulls: { enabled: false } }))]) {
      const store = G.memStore();
      const graph = recordingGraph();
      const { svc } = await G.service(S, store, { graph });
      for (let i = 0; i < 40; i += 1) svc.runPass(NOW + i * 60000);
      const views = Array.from({ length: 120 }, (_, i) => svc.pilot(i + 1));
      const st = svc.getStatus();
      const panel = buildPopulationPanel({ service: svc, settings: S, clock: { now: () => NOW } }).getData();
      assert.ok(!("hulls" in st) && !("hulls" in panel));
      assert.ok(graph.calls.length > 0 && graph.calls.every((c) => c.c === graph.calls[0].c));
      assert.deepStrictEqual(graph.calls[0].c, { maxJumps: 12 });
      for (const v of views) assert.ok(ARCHETYPES[ARCHETYPE[v.archetype]].hulls.includes(v.shipTypeId));
      svc.stop();
      runs.push({ views, rows: [...store.db.rows.values()] });
    }
    assert.deepStrictEqual(runs[0], runs[1]);
    assert.ok(runs[0].views.some((v) => v.seq > 1), "the population moved");

    const pop = TP.fakePopulation([pilotCand(1, OBELISK), pilotCand(2, BADGER)]);
    const h = TP.harness({ pop, extra: { profilesByRole: civilianProfilesByRole(CIV) } });
    h.tick();
    const st = h.traffic.status();
    assert.deepStrictEqual([st.counters.pilotHullFallback, st.counters.pilotNoLiveProfile, "pilotHulls" in st],
      [1, 0, false]);
    assert.strictEqual(spawnSpecs(h)[1].profileId, "lne_civ_badger");

    assert.strictEqual(CIV.civilianDataOf(), CIV);
    assert.strictEqual(CIV.civilianDataOf({ pilotHulls: false }), CIV);

    const env0 = { EVEJS_DATA_ROOT: os.tmpdir() };
    const def = resolveConfig({ modDir: MOD_DIR, env: env0 });
    assert.deepStrictEqual(def.config.population.hulls, { enabled: false, restrictedAvoidSecClasses: "nullsec" });
    assert.strictEqual(config.SCHEMA.filter((r) => r.key.startsWith("population.hulls.")).length, 2);
    assert.ok(!def.warnings.some((x) => /W25[78]/.test(x)));
    const bad = resolveConfig({ modDir: MOD_DIR, env: { ...env0,
      EVEJS_LNE_POPULATION_HULLS_RESTRICTED_AVOID_SEC_CLASSES: "highsec" } });
    assert.strictEqual(bad.config.population.hulls.restrictedAvoidSecClasses, "nullsec");
    assert.ok(bad.warnings.some((x) => /RESTRICTED_AVOID_SEC_CLASSES.*ignored/.test(x)), bad.warnings.join(" | "));
    const on = { ...env0, EVEJS_LNE_POPULATION_HULLS_ENABLED: "1" };
    const none = resolveConfig({ modDir: MOD_DIR, env: { ...on, EVEJS_LNE_POPULATION_ENABLED: "1",
      EVEJS_LNE_POPULATION_HULLS_RESTRICTED_AVOID_SEC_CLASSES: "nullsec, lowsec" } });
    assert.deepStrictEqual(settingsOf(none.config).hulls.avoidSecClasses, ["lowsec", "nullsec"]);
    const noneList = resolveConfig({ modDir: MOD_DIR, env: { ...on, EVEJS_LNE_POPULATION_ENABLED: "1",
      EVEJS_LNE_POPULATION_HULLS_RESTRICTED_AVOID_SEC_CLASSES: "none" } });
    assert.deepStrictEqual(settingsOf(noneList.config).hulls.avoidSecClasses, []);
    const w1 = resolveConfig({ modDir: MOD_DIR, env: on }).warnings;
    assert.ok(w1.some((x) => /\(W257\)/.test(x)), w1.join(" | "));
    const liveOn = { ...on, EVEJS_LNE_POPULATION_ENABLED: "1", EVEJS_LNE_POPULATION_LIVE_TRAFFIC_ENABLED: "1" };
    const w2 = resolveConfig({ modDir: MOD_DIR, env: liveOn }).warnings;
    assert.ok(w2.some((x) => /\(W258\)/.test(x)) && !w2.some((x) => /W257/.test(x)), w2.join(" | "));
    const w3 = resolveConfig({ modDir: MOD_DIR, env: { ...liveOn, EVEJS_LNE_HIGHSEC_LIFE_CIVILIAN_HULLS_ENABLED: "1" } });
    assert.ok(!w3.warnings.some((x) => /W258/.test(x)), w3.warnings.join(" | "));
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
