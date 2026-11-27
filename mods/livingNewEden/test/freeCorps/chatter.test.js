"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { startFreeCorps } = require("../../lib/freeCorps");
const { FACADE_METHODS } = require("../../lib/freeCorps/schema");
const { pickResidentLine, fillResidentTemplate, formatIsk, contextOf } = require("../../lib/freeCorps/chatter");
const { CONTEXTS, PLACEHOLDERS, LINES } = require("../../lib/freeCorps/data/chatterLines");
const { toFreeCorpRumour, toWarRumour } = require("../../lib/highsecLife/rumours");
const { fillTemplate, PLACEHOLDERS: CIV_PLACEHOLDERS } = require("../../lib/highsecLife/chatter");
const { RUMOURS } = require("../../lib/highsecLife/data/chatterLines");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 2000000000000;
const ON_ENV = Object.freeze({ EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1" });
const X = 30000001;
const Y = 30000002;
const Z = 30000003;
const RUMOUR_FIELDS = ["at", "attackerName", "defenderName", "key", "kind", "losses", "regionName", "systemId",
  "systemName"];
const charsOf = (corpId, n) => Array.from({ length: n }, (_v, i) => 91000000 + corpId * 100 + i);
const ASCII = /^[\x20-\x7E]+$/;

function cfgOf({ chatter = true } = {}) {
  const r = config.resolveConfig({ modDir: MOD_DIR, env: ON_ENV });
  assert.deepStrictEqual(r.errors, []);
  const c = r.config;
  const f = c.freeCorps;
  return { ...c, freeCorps: { ...f, targetCorps: 0,
    ventures: { ...f.ventures, enabled: true }, local: { ...f.local, enabled: true, homeIdlePermille: 1000 },
    chatter: { ...f.chatter, enabled: chatter } } };
}

function fakeVc(identities) {
  return { calls: 0, ensureOwnerIdentity: () => ({ ok: true, queued: true }),
    getOwnerIdentity(kind, id) {
      this.calls += 1;
      assert.strictEqual(kind, "free");
      const ids = identities.get(id);
      return ids ? { ok: true, state: "LINKED", corporationId: 98000000 + id, characterIds: ids.slice() }
        : { ok: true, state: "PENDING" };
    },
    getMapVersion: () => 7,
    countOwnerCharacters: () => ({ ok: true, ready: true, total: 0 }) };
}

function boot(opened, cfg) {
  const clock = createManualClock(T0);
  const vc = fakeVc(new Map([[1, charsOf(1, 5)], [2, charsOf(2, 4)], [3, charsOf(3, 3)]]));
  const r = startFreeCorps({ config: cfg, clock, logger: { log() {} }, telemetry: null,
    persistence: { store: opened.store, journal: createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 }),
      worldSeed: opened.worldSeed },
    getGraph: () => null, getVirtualCorps: () => vc, getGovernor: () => null,
    listStations: () => ({ ok: true, stations: [] }), bloodlinesOf: () => [1], raceSourceFactionIds: [500001],
    excludedRegionIds: [], reservedNames: () => ({ names: new Set(), tickers: new Set() }),
    setTimer: () => ({ cancel() {}, hasRef: () => false }), nowMs: () => 0 });
  assert.ok(r.ok, JSON.stringify(r));
  return { fc: r.freeCorps, vc };
}

function exec(opened, sql, ...args) {
  const r = opened.store.transaction("t.exec", (db) => db.prepare(sql).run(...args));
  assert.ok(r.ok, JSON.stringify(r));
}

function corp(opened, corpId, archetype, state, home, members) {
  exec(opened, "INSERT INTO world_free_corps (corp_id, archetype, state, open, name, ticker, sec_band, home_system_id, "
    + "home_station_id, home_station_corp_id, race_faction_id, members_target, corporation_id, isk, struggle_count, "
    + "seed, name_attempt, venture_seq, next_at, founded_at, updated_at, version) VALUES (?, ?, ?, 1, ?, ?, 'highsec', "
    + "?, 60000001, 1000100, 500001, ?, ?, 200000000, 0, 1, 0, 0, ?, ?, ?, 1)", corpId, archetype, state,
  `Corp ${corpId}`, `TC${corpId}`, home, members, 98000000 + corpId, T0 + 3600000, T0, T0);
}

function venture(opened, v) {
  const closed = Number.isFinite(v.endedAt);
  exec(opened, "INSERT INTO world_free_corp_ventures (venture_id, corp_id, seq, kind, state, open, home_system_id, "
    + "system_id, target_system_id, sec_band, jumps, crew, crew_lost, step, travel_steps, work_steps, steps_total, "
    + "yield_isk, cost_isk, started_at, step_due_at, updated_at, ended_at, end_reason, version) VALUES (?, ?, ?, ?, ?, "
    + "?, ?, ?, ?, 'highsec', 1, ?, ?, 2, 1, 2, 4, ?, ?, ?, ?, ?, ?, ?, 1)", v.id, v.corp, v.seq, v.kind, v.state,
  closed ? 0 : 1, v.home, v.system, v.target, v.crew, v.crewLost || 0, v.yieldIsk || 0, v.costIsk || 0, T0 - 900000,
  T0 + 900000, T0, closed ? v.endedAt : null, closed ? v.endReason || v.state : null);
}

function seedWorld(opened) {
  corp(opened, 1, "miner", "ACTIVE", Y, 5);
  corp(opened, 2, "hauler", "ACTIVE", Y, 4);
  corp(opened, 3, "ratter", "STRUGGLING", Z, 3);
  venture(opened, { id: "fcv:1:1", corp: 1, seq: 1, kind: "MINE", state: "WORKING", home: Y, system: X, target: X,
    crew: 3 });
  venture(opened, { id: "fcv:2:1", corp: 2, seq: 1, kind: "RAT", state: "LOST", home: Y, system: Z, target: Z, crew: 3,
    crewLost: 2, costIsk: 40000000, endedAt: T0 - 1000 });
}

const NAMES = new Map([[X, "Exa"], [Y, "Wye"], [Z, "Zed"]]);

const K3_FINGERPRINT = "79f2eb745bf147dfcc685828eae4c22971795df605b01ae3d8cf1b1386dd5bc2";
const K3_SPEAKERS = Object.freeze([
  { characterId: 93000001, corpName: "Null Diggers", ticker: "NDIG", archetype: "miner", homeSystemId: Y,
    role: "CREW", venture: { kind: "MINE", state: "WORKING", systemId: X, yieldIsk: 0 }, last: null },
  { characterId: 93000002, corpName: "Null Diggers", ticker: "NDIG", archetype: "miner", homeSystemId: Y,
    role: "HOME", venture: null, last: { kind: "RAT", outcome: "LOST", systemId: Z, crewLost: 2, yieldIsk: 0 } },
  { characterId: 93000003, corpName: "Null Diggers", ticker: "NDIG", archetype: "hauler", homeSystemId: Y,
    role: "HOME", venture: null, last: null },
]);

function k3Input(slot, over) {
  return { systemId: Y, slot, seed: 77, speakers: K3_SPEAKERS, lastSpeaker: slot % 3 === 0 ? 93000002 : null,
    recentLineIds: [], listenerName: "Wye", nameOf: (id) => NAMES.get(id) || null, minRichIsk: 150000000,
    maxLineChars: 240, ...(over || {}) };
}

function withoutSource(r) {
  const { source, ...rest } = r;
  return rest;
}

module.exports = ({ test, skip }) => {
  test("K3: pickResidentLine without ai / null / permille 0 = the result on 200 slots "
    + "(fingerprint); permille 1000 -> the AI template of fc.<context of the line> with {corp}; no fill / throw -> "
    + "static", () => {
    const plain = [];
    for (let slot = 0; slot < 200; slot += 1) {
      const a = pickResidentLine(k3Input(slot));
      assert.deepStrictEqual(pickResidentLine(k3Input(slot, { ai: null })), a, `ai null, slot ${slot}`);
      assert.deepStrictEqual(pickResidentLine(k3Input(slot, { ai: { permille: 0, linesOf: () => {
        throw new Error("never asked");
      } } })), a, `permille 0, slot ${slot}`);
      assert.strictEqual(a.source, "static");
      plain.push(withoutSource(a));
    }
    assert.strictEqual(require("node:crypto").createHash("sha256").update(JSON.stringify(plain)).digest("hex"),
      K3_FINGERPRINT, "the draws [1]-[2] did not move");

    const asked = new Set();
    const ai = { permille: 1000, linesOf: (key) => {
      asked.add(key);
      return [{ id: `ai-${key}-1`, text: "{corp} out here, fly safe" }];
    } };
    for (let slot = 0; slot < 50; slot += 1) {
      const s = pickResidentLine(k3Input(slot));
      const a = pickResidentLine(k3Input(slot, { ai }));
      assert.deepStrictEqual([a.characterId, a.context, a.text, a.source], [s.characterId, s.context,
        "Null Diggers out here, fly safe", "ai"], `slot ${slot}`);
      const ctxOfLine = s.lineId.startsWith("fc-generic-") ? "GENERIC" : s.context;
      assert.strictEqual(a.lineId, `ai-fc.${ctxOfLine}-1`);
    }
    assert.ok([...asked].every((k) => /^fc\.[A-Za-z_]+$/.test(k)) && asked.size >= 2, [...asked].join(","));
    for (const bad of [{ permille: 1000, linesOf: () => [{ id: "ai-x-1", text: "{corp} made {isk} today" }] },
      { permille: 1000, linesOf: () => { throw new Error("pool broke"); } }]) {
      for (let slot = 0; slot < 50; slot += 1) {
        const s = pickResidentLine(k3Input(slot));
        assert.deepStrictEqual(pickResidentLine(k3Input(slot, { ai: bad })), s, `slot ${slot}`);
      }
    }
  });

  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("FC5-1 chatterSpeakers = the residents of residentsFor with role / venture / last; CHATTER_DISABLED "
    + "without a virtualCorps call; facade keys; pickResidentLine LAST_LOST deterministic with corp / place", () => {
    withStore(driver, (opened) => {
      seedWorld(opened);
      const A = charsOf(1, 5);
      const B = charsOf(2, 4);
      const env = boot(opened, cfgOf());
      assert.deepStrictEqual(Object.keys(env.fc).filter((k) => FACADE_METHODS.includes(k)).sort(),
        FACADE_METHODS.slice().sort(), "the real facade has every FACADE_METHODS");
      for (const systemId of [X, Y]) {
        const res = env.fc.residentsFor([systemId], T0);
        const sp = env.fc.chatterSpeakers(systemId, T0);
        assert.strictEqual(sp.ok, true, JSON.stringify(sp));
        assert.deepStrictEqual(sp.speakers.map((s) => s.characterId),
          [...res.bySystem.get(systemId)].sort((a, b) => a - b), `the residents of ${systemId}`);
      }
      const x = env.fc.chatterSpeakers(X, T0).speakers;
      assert.deepStrictEqual(x.map((s) => [s.characterId, s.role, s.corpName, s.ticker, s.archetype, s.homeSystemId]),
        A.slice(0, 3).map((id) => [id, "CREW", "Corp 1", "TC1", "miner", Y]));
      assert.deepStrictEqual({ ...x[0].venture }, { kind: "MINE", state: "WORKING", systemId: X, yieldIsk: 0 });
      assert.strictEqual(x[0].last, null);
      const y = env.fc.chatterSpeakers(Y, T0).speakers;
      assert.deepStrictEqual(y.map((s) => [s.characterId, s.role]), [...A.slice(3), ...B].map((id) => [id, "HOME"]));
      const lost = y.filter((s) => s.corpId === 2);
      assert.deepStrictEqual({ ...lost[0].last }, { kind: "RAT", outcome: "LOST", endReason: "LOST", systemId: Z,
        crewLost: 2, yieldIsk: 0, endedAt: T0 - 1000 });
      assert.strictEqual(env.fc.chatterSpeakers(Y, T0 + 7 * 3600000).speakers.find((s) => s.corpId === 2).last, null,
        "older than rumourMaxAgeMs: no last");
      assert.deepStrictEqual(env.fc.chatterSpeakers(0, T0), { ok: false, reason: "INVALID_INPUT" });
      assert.strictEqual(env.fc.getStatus().counters.chatterReads, 5);

      const input = (slot) => ({ systemId: Y, slot, seed: 77, speakers: lost, lastSpeaker: null, recentLineIds: [],
        listenerName: "Wye", nameOf: (id) => NAMES.get(id) || null, minRichIsk: 150000000, maxLineChars: 240 });
      assert.deepStrictEqual(pickResidentLine(input(5)), pickResidentLine(input(5)), "deterministic");
      const picks = Array.from({ length: 24 }, (_v, slot) => pickResidentLine(input(slot)));
      assert.ok(picks.every((p) => p.ok && p.context === "LAST_LOST" && B.includes(p.characterId)
        && !p.text.includes("{") && !p.text.includes("null")), JSON.stringify(picks));
      assert.ok(picks.some((p) => p.text.includes("Corp 2")) && picks.some((p) => p.text.includes("Zed")),
        picks.map((p) => p.text).join(" | "));
      assert.ok(picks.some((p) => p.text.includes("2 ships")), "the lost ships");
      const crew = (kind, st) => ({ role: "CREW", archetype: "explorer", venture: { kind, state: st, yieldIsk: 0 },
        last: null });
      assert.deepStrictEqual([contextOf(crew("EXPLORE_WH", "WORKING"), 1), contextOf(crew("EXPLORE_WH", "STRANDED"), 1)],
        ["WORK_EXPLORE", "GENERIC"]);
      env.fc.stop();

      const off = boot(opened, cfgOf({ chatter: false }));
      assert.deepStrictEqual(off.fc.chatterSpeakers(Y, T0), { ok: false, reason: "CHATTER_DISABLED" });
      assert.deepStrictEqual(off.fc.ventureNews({ afterAt: 0, afterId: null, limit: 1, minYieldIsk: 0,
        minCrewLost: 1 }), { ok: false, reason: "CHATTER_DISABLED" });
      assert.strictEqual(off.vc.calls, 0, "no virtualCorps call");
      off.fc.stop();
    });
  });

  needsDriver("FC5-4 ventureNews keyset across a tie (effective limit), keys fc:<id>, then empty; FC rumour shape; "
    + "toWarRumour drops FC_*; every FC template and resident line fills and is ASCII; catalogue minima", () => {
    withStore(driver, (opened) => {
      corp(opened, 1, "miner", "ACTIVE", Y, 5);
      corp(opened, 2, "hauler", "ACTIVE", Y, 4);
      corp(opened, 3, "industrialist", "ACTIVE", Z, 3);
      const closed = (id, corpId, seq, kind, state, endedAt, o) => venture(opened, { id, corp: corpId, seq, kind, state,
        home: Y, system: X, target: X, crew: 3, endedAt, ...o });
      closed("fcv:1:9", 1, 9, "RAT", "LOST", T0 + 100, { crewLost: 2, costIsk: 40000000 });
      closed("fcv:1:8", 1, 8, "MINE", "DONE", T0 + 50, { yieldIsk: 10000000 });
      closed("fcv:2:9", 2, 9, "HAUL", "DONE", T0 + 100, { yieldIsk: 200000000 });
      closed("fcv:3:9", 3, 9, "BUILD", "DONE", T0 + 20, { yieldIsk: 300000000, costIsk: 900000000 });
      closed("fcv:3:8", 3, 8, "EXPLORE", "ABORTED", T0 + 30, { endReason: "NO_TARGET" });
      const env = boot(opened, cfgOf());
      const q = { afterAt: T0 - 1, afterId: null, limit: 1, minYieldIsk: 150000000, minCrewLost: 1 };
      const page = env.fc.ventureNews(q);
      assert.strictEqual(page.ok, true, JSON.stringify(page));
      assert.deepStrictEqual(page.items.map((i) => [i.key, i.kind, i.corpName, i.systemId, i.endedAt, i.crewLost,
        i.yieldIsk]), [["fc:fcv:1:9", "FC_LOST", "Corp 1", X, T0 + 100, 2, 0],
        ["fc:fcv:2:9", "FC_RICH", "Corp 2", X, T0 + 100, 0, 200000000]]);
      assert.strictEqual(page.full, false, "limit 1 -> effective maxCorpsPerPass + 1 (33): both of the tie, one page");
      const last = page.items[page.items.length - 1];
      const next = env.fc.ventureNews({ ...q, afterAt: last.endedAt, afterId: last.ventureId });
      assert.deepStrictEqual([next.ok, next.items.length, next.full], [true, 0, false], "from the cursor: empty");
      assert.deepStrictEqual(env.fc.ventureNews({ ...q, limit: 0 }), { ok: false, reason: "INVALID_INPUT" });
      assert.deepStrictEqual([env.fc.getStatus().counters.newsReads, env.fc.getStatus().counters.newsFailed], [2, 0]);

      const placeOf = (id) => (NAMES.has(id) ? { name: NAMES.get(id), regionName: "Region" } : null);
      const r = toFreeCorpRumour(page.items[0], placeOf);
      assert.deepStrictEqual([Object.keys(r).sort(), r.key, r.kind, r.defenderName, r.attackerName, r.losses,
        r.systemName], [RUMOUR_FIELDS, "fc:fcv:1:9", "FC_LOST", "Corp 1", null, 2, "Exa"]);
      assert.strictEqual(toFreeCorpRumour(page.items[1], placeOf).losses, null);
      assert.strictEqual(toFreeCorpRumour({ ...page.items[0], systemId: 31999999 }, placeOf), null, "unknown place");
      for (const kind of ["FC_LOST", "FC_RICH"]) {
        assert.strictEqual(toWarRumour({ eventKey: "j:1:x", kind, systemId: X, at: T0, systemName: "Exa" }), null);
      }
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      corp(opened, 1, "ratter", "ACTIVE", Y, 5);
      for (let s = 1; s <= 5; s += 1) {
        venture(opened, { id: `fcv:1:${s}`, corp: 1, seq: s, kind: "RAT", state: "LOST", home: Y, system: X, target: X,
          crew: 3, crewLost: 1, costIsk: 20000000, endedAt: T0 + 500 });
      }
      const base = cfgOf();
      const env = boot(opened, { ...base, freeCorps: { ...base.freeCorps, maxCorpsPerPass: 2 } });
      const q = { afterAt: T0, afterId: null, limit: 1, minYieldIsk: 150000000, minCrewLost: 1 };
      const p1 = env.fc.ventureNews(q);
      assert.deepStrictEqual([p1.ok, p1.items.length, p1.full], [true, 3, true], JSON.stringify(p1));
      const at = p1.items[2];
      const p2 = env.fc.ventureNews({ ...q, afterAt: at.endedAt, afterId: at.ventureId });
      assert.deepStrictEqual([p2.ok, p2.items.length, p2.full], [true, 2, false], JSON.stringify(p2));
      assert.deepStrictEqual([...p1.items, ...p2.items].map((i) => i.ventureId),
        ["fcv:1:1", "fcv:1:2", "fcv:1:3", "fcv:1:4", "fcv:1:5"], "the whole tie once");
      env.fc.stop();
    });

    const civFull = Object.fromEntries(CIV_PLACEHOLDERS.map((p) => [p, `v-${p}`]));
    for (const kind of ["FC_LOST", "FC_RICH"]) {
      assert.ok(RUMOURS[kind].length >= 3, kind);
      assert.ok(RUMOURS[kind].some((t) => !t.text.includes("{defender}")), `${kind} without {defender}`);
      for (const t of RUMOURS[kind]) {
        const text = fillTemplate(t.text, civFull);
        assert.ok(text !== null && ASCII.test(text), `${t.id}: ${t.text}`);
      }
    }
    const full = Object.fromEntries(PLACEHOLDERS.map((p) => [p, `v-${p}`]));
    assert.deepStrictEqual(Object.keys(LINES), [...CONTEXTS]);
    let total = 0;
    const ids = new Set();
    for (const ctx of CONTEXTS) {
      const list = LINES[ctx];
      assert.ok(list.length >= (ctx === "GENERIC" ? 6 : 3), `${ctx} ${list.length}`);
      assert.ok(list.some((t) => fillResidentTemplate(t.text, { corp: "C", ticker: "T" }) !== null),
        `${ctx}: a line with only {corp}/{ticker}`);
      for (const t of list) {
        assert.ok(t.id.startsWith(`fc-${ctx.toLowerCase()}-`) && !ids.has(t.id), t.id);
        ids.add(t.id);
        const text = fillResidentTemplate(t.text, full);
        assert.ok(text !== null && ASCII.test(t.text) && ASCII.test(text), `${t.id}: ${t.text}`);
      }
      total += list.length;
    }
    assert.ok(total >= 70, `total ${total}`);
    assert.deepStrictEqual([formatIsk(150000000), formatIsk(900000), formatIsk(0)], ["150M", "0.9M", "0.0M"]);
  });
};
