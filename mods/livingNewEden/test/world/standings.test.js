"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { startStandings } = require("../../lib/world/standings");
const S = require("../../lib/world/standings/schema");
const { classifySystem, resolveBeneficiary, planGrant, validateData } =
  require("../../lib/world/standings/standingsRules");
const { STANDINGS_DATA_V1 } = require("../../lib/world/standings/data/standingsData");
const { applyStandingGrantFrom } = require("../../lib/adapter/standingWrite");
const killObservation = require("../../lib/adapter/killObservation");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { resolveConfig, isStandingsEnabled } = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const PIRATES = Object.freeze(new Set([500010, 500011, 500012, 500019, 500020, 500025]));
const CALDARI = 500001;
const AMARR = 500003;
const GURISTAS = 500010;
const SANSHA = 500019;
const ROGUE_DRONES = 500025;
const WINDOW_MS = 600000;

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], [], JSON.stringify(r.errors));
  return r.config;
}

function fakeRuntime() {
  const receipts = new Map();
  const rt = { applied: 0, duplicate: 0, calls: 0, throwNext: false,
    applyStandingChanges(characterID, changes, options) {
      rt.calls += 1;
      if (rt.throwNext) throw new Error("vendor boom");
      const key = options.idempotencyKey;
      const fp = JSON.stringify({ characterID, changes, disableDerived: options.disableDerived === true,
        preservePrecision: options.preservePrecision === true });
      if (receipts.has(key)) {
        if (receipts.get(key) !== fp) return { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
        rt.duplicate += 1;
        return { success: true, duplicate: true, data: { modifications: [], appliedChanges: [] } };
      }
      receipts.set(key, fp);
      rt.applied += 1;
      return { success: true, data: { modifications: [], appliedChanges: [{ fromID: changes[0].ownerID,
        toID: characterID, rawChange: changes[0].rawChange, previousStanding: 0, standing: 10 * changes[0].rawChange }] } };
    } };
  return rt;
}

function fakeAdapter(rt) {
  const spy = { writes: 0 };
  return { spy, applyStandingGrant(grant, data) {
    spy.writes += 1;
    return applyStandingGrantFrom(rt, grant, data);
  }, checkStandingWrite: () => ({ ok: true }), readPirateFactionIds: () => ({ ok: true, ids: PIRATES }) };
}

function bootStd(opened, shared, envOver, rt) {
  const config = configOf(envOver);
  const env = H.boot(opened, shared);
  const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
  const adapter = fakeAdapter(rt);
  const lines = [];
  const captured = {};
  const scheduler = { ...env.scheduler, registerHandler(type, fn, opts) {
    captured[type] = fn;
    return env.scheduler.registerHandler(type, fn, opts);
  } };
  const r = startStandings({ config, persistence: { ok: true, store: env.store, journal: env.journal },
    clock: shared.clock, scheduler, world: { repository: repo },
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, adapter,
    logger: { log: (l) => lines.push(l) }, nowMs: () => 0 });
  assert.ok(r.ok, JSON.stringify(r));
  return { ...env, repo, standings: r.standings, adapter, lines, handler: captured[S.EVENT_TYPE], config };
}

function seedSystem(env, systemId, controller) {
  const r = env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
    state: { securityClass: "nullsec", controllerFactionId: controller },
    influence: [{ factionId: controller, influenceScore: 60 }] }, `world:seed:v1:${systemId}`));
  assert.ok(r.ok, JSON.stringify(r));
}

const outboxRows = (env) => env.tx((db) => db.prepare(`SELECT idempotency_key AS k, state, error FROM
  world_event_journal WHERE event_type = ? ORDER BY journal_id`).all(S.EVENT_TYPE));
const grantEvents = (env) => env.tx((db) => db.prepare(`SELECT idempotency_key AS k, state, attempts, payload,
  created_at AS createdAt, due_at AS dueAt FROM world_scheduled_events WHERE event_type = ? ORDER BY created_at,
  idempotency_key`).all(S.EVENT_TYPE));
const evOf = (row) => ({ idempotencyKey: row.k, payload: JSON.parse(row.payload), createdAt: row.createdAt,
  dueAt: row.dueAt });

async function passesAt(env, shared, at) {
  shared.clock.set(at);
  for (let i = 0; i < 20; i += 1) {
    const p = await env.scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    if (!p.jobs) return;
  }
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const { S: SYS } = H;

  test("S1 rules: classification matrix, NOT_PIRATE, beneficiary order, never a pirate, rogue drones", () => {
    const sys = (state, controller, occupier = null) => ({ occupationState: state, controllerFactionId: controller,
      occupierFactionId: occupier });
    assert.deepStrictEqual(classifySystem(sys("STABLE", GURISTAS), PIRATES), { ok: true, basis: "PIRATE_HELD" });
    assert.deepStrictEqual(classifySystem(sys("OCCUPIED", SANSHA, SANSHA), PIRATES), { ok: true, basis: "PIRATE_HELD" });
    assert.deepStrictEqual(classifySystem(sys("CONTESTED", CALDARI, GURISTAS), PIRATES),
      { ok: true, basis: "CONTESTED" }, "pirate as the claimant");
    assert.deepStrictEqual(classifySystem(sys("RECON", GURISTAS, CALDARI), PIRATES).ok, true, "pirate as controller");
    assert.strictEqual(classifySystem(sys("STABLE", null), PIRATES).reason, "NOT_PIRATE_SYSTEM", "free STABLE");
    assert.strictEqual(classifySystem(sys("STABLE", CALDARI), PIRATES).reason, "NOT_PIRATE_SYSTEM", "empire");
    assert.strictEqual(classifySystem(sys("OCCUPIED", CALDARI, CALDARI), PIRATES).reason, "NOT_PIRATE_SYSTEM");

    const ctx = { pirateIds: PIRATES, data: STANDINGS_DATA_V1, params: { debounceWindowMs: 0, rawChangePerGrant: 2e-4 } };
    const kill = { characterId: 7, victimFactionId: GURISTAS, systemId: 30000001, atMs: 5 * S.DAY_MS + 9 };
    assert.strictEqual(planGrant({ ...kill, victimFactionId: CALDARI }, sys("STABLE", GURISTAS), null, ctx).reason,
      "NOT_PIRATE", "an empire navy kill never pays");
    assert.strictEqual(planGrant(kill, null, null, ctx).reason, "NO_ROW");
    assert.strictEqual(planGrant({ ...kill, characterId: 0 }, null, null, ctx).reason, "KILL_INVALID_INPUT");
    const data = { ...STANDINGS_DATA_V1, beneficiaryByRegion: { 10000041: 500004 } };
    const fight = resolveBeneficiary(kill, sys("CONTESTED", GURISTAS, 500002), { regionId: 10000041,
      factionId: CALDARI }, PIRATES, data);
    assert.deepStrictEqual(fight, { ok: true, factionId: 500002, source: "FIGHTER" });
    assert.deepStrictEqual(resolveBeneficiary(kill, sys("STABLE", GURISTAS), { regionId: 10000041, factionId: CALDARI },
      PIRATES, data), { ok: true, factionId: 500004, source: "REGION" });
    const syndicate = planGrant({ ...kill, victimFactionId: 500020 }, sys("STABLE", 500020),
      { regionId: 10000041, factionId: CALDARI }, ctx);
    assert.deepStrictEqual([syndicate.factionId, syndicate.source, syndicate.basis], [CALDARI, "SDE_SYSTEM",
      "PIRATE_HELD"]);
    const stain = planGrant({ ...kill, victimFactionId: SANSHA }, sys("STABLE", SANSHA),
      { regionId: 10000022, factionId: SANSHA }, ctx);
    assert.deepStrictEqual([stain.factionId, stain.source], [AMARR, "RIVAL"]);
    assert.strictEqual(planGrant({ ...kill, victimFactionId: ROGUE_DRONES }, sys("STABLE", ROGUE_DRONES),
      { regionId: 1, factionId: 0 }, ctx).reason, "NO_BENEFICIARY", "rogue drones with no fighter");
    assert.deepStrictEqual(resolveBeneficiary(kill, sys("CONTESTED", GURISTAS, SANSHA), { regionId: 1,
      factionId: 500009 }, PIRATES, STANDINGS_DATA_V1), { ok: true, factionId: CALDARI, source: "RIVAL" });
    assert.strictEqual(planGrant(kill, sys("STABLE", GURISTAS), null, ctx).key, `lne:std:7:5:${CALDARI}:30000001:k${kill.atMs}`);
    const withVictim = planGrant({ ...kill, victimId: 77 }, sys("STABLE", GURISTAS), null, ctx);
    assert.deepStrictEqual([withVictim.key, withVictim.legacyKey], [`lne:std:7:5:${CALDARI}:30000001:k${kill.atMs}.77`,
      `lne:std:7:5:${CALDARI}:30000001:k${kill.atMs}`], "Victim identity + the legacy key");
    const w = planGrant(kill, sys("STABLE", GURISTAS), null, { ...ctx, params: { debounceWindowMs: WINDOW_MS,
      rawChangePerGrant: 2e-4 } });
    assert.strictEqual(w.key, `lne:std:7:5:${CALDARI}:30000001:${Math.floor(kill.atMs / WINDOW_MS)}`);
    assert.deepStrictEqual([S.dayPrefix(7, 5), S.dayRangeEnd(S.dayPrefix(7, 5))], ["lne:std:7:5:", "lne:std:7:5;"]);
    assert.deepStrictEqual(validateData(STANDINGS_DATA_V1, PIRATES), { ok: true });
    assert.strictEqual(validateData({ ...STANDINGS_DATA_V1, eligibleBeneficiaries: [500001, 500010] }, PIRATES).reason,
      "STANDINGS_DATA_INVALID");
    assert.strictEqual(validateData({ ...STANDINGS_DATA_V1, rivalByPirate: { 500010: 500009 } }, PIRATES).reason,
      "STANDINGS_DATA_INVALID");
  });

  needsDriver("S2 exactly once: debounce window, vendor receipts across a crash before DONE, restart, expired", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = fakeRuntime();
      const env = bootStd(reopen(), shared, { EVEJS_LNE_STANDINGS_DEBOUNCE_WINDOW_MS: String(WINDOW_MS) }, rt);
      seedSystem(env, SYS.N5, GURISTAS);
      const base = shared.clock.now();
      const kill = (atMs, characterId = 7) => env.standings.onNpcKill({ characterId, victimFactionId: GURISTAS,
        systemId: SYS.N5, atMs });
      assert.deepStrictEqual([kill(base).outcome, kill(base + 1).outcome], ["GRANTED", "DEBOUNCED"]);
      assert.deepStrictEqual([outboxRows(env).length, grantEvents(env).length], [1, 1]);
      assert.strictEqual(kill(base + WINDOW_MS).outcome, "GRANTED", "the next window grants again");
      const first = evOf(grantEvents(env)[0]);
      const h1 = env.handler(first, { now: base });
      const h2 = env.handler(first, { now: base });
      assert.deepStrictEqual([h1.outcome, h2.outcome, rt.applied, rt.duplicate], ["APPLIED", "DUPLICATE", 1, 1]);
      await passesAt(env, shared, base);
      assert.deepStrictEqual(outboxRows(env).map((r) => r.state), ["APPLIED", "APPLIED"]);
      assert.strictEqual(rt.applied, 2, "two grants, each written once");
      assert.ok(env.lines.some((l) => l.startsWith(`standings: +${env.config.standings.rawChangePerGrant} char=7`)));
      env.standings.stop("restart");
      env.store.close("restart");
      const env2 = bootStd(reopen(), shared, { EVEJS_LNE_STANDINGS_DEBOUNCE_WINDOW_MS: String(WINDOW_MS) }, rt);
      assert.strictEqual(env2.standings.onNpcKill({ characterId: 7, victimFactionId: GURISTAS, systemId: SYS.N5,
        atMs: base }).outcome, "DEBOUNCED");
      const calls = rt.calls;
      assert.strictEqual(env2.standings.onNpcKill({ characterId: 7, victimFactionId: GURISTAS, systemId: SYS.N5,
        atMs: base + 2 * WINDOW_MS }).outcome, "GRANTED");
      await passesAt(env2, shared, base + env2.config.standings.grantMaxAgeMs + 1);
      assert.strictEqual(rt.calls, calls, "no vendor call for an expired grant");
      const last = outboxRows(env2).pop();
      assert.deepStrictEqual([last.state, last.error], ["FAILED", "EXPIRED"]);
      assert.strictEqual(env2.standings.getStatus().counters.expired, 1);
      env2.standings.stop("test");
    }));

  needsDriver("S3 daily cap: on by config (third grant DAILY_CAP, next UTC day / other character grant); default off",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = fakeRuntime();
      const env = bootStd(reopen(), shared, { EVEJS_LNE_STANDINGS_MAX_GRANTS_PER_CHARACTER_DAY: "2",
        EVEJS_LNE_STANDINGS_DEBOUNCE_WINDOW_MS: String(WINDOW_MS) }, rt);
      seedSystem(env, SYS.N5, GURISTAS);
      const day0 = (Math.floor(shared.clock.now() / S.DAY_MS) + 1) * S.DAY_MS;
      const kill = (atMs, characterId = 7) => env.standings.onNpcKill({ characterId, victimFactionId: GURISTAS,
        systemId: SYS.N5, atMs }).outcome;
      assert.deepStrictEqual([kill(day0), kill(day0 + WINDOW_MS), kill(day0 + 2 * WINDOW_MS)],
        ["GRANTED", "GRANTED", "DAILY_CAP"]);
      assert.strictEqual(outboxRows(env).length, 2, "the capped kill wrote nothing");
      assert.strictEqual(kill(day0 + S.DAY_MS), "GRANTED", "next UTC day");
      assert.strictEqual(kill(day0 + 3 * WINDOW_MS, 8), "GRANTED", "another character the same day");
      assert.strictEqual(env.standings.getStatus().counters.dailyCap, 1);
      env.standings.stop("test");
      env.store.close("next");
      const env2 = bootStd(reopen(), shared, {}, rt);
      assert.deepStrictEqual([env2.config.standings.maxGrantsPerCharacterDay, env2.config.standings.debounceWindowMs],
        [0, 0]);
      const before = outboxRows(env2).length;
      const outcomes = [];
      for (let i = 0; i < 12; i += 1) {
        outcomes.push(env2.standings.onNpcKill({ characterId: 9, victimFactionId: GURISTAS, systemId: SYS.N5,
          atMs: day0 + i }).outcome);
      }
      assert.deepStrictEqual(outcomes, new Array(12).fill("GRANTED"));
      assert.strictEqual(env2.standings.onNpcKill({ characterId: 9, victimFactionId: GURISTAS, systemId: SYS.N5,
        atMs: day0 }).outcome, "DEBOUNCED", "the same kill again is a duplicate");
      const rows = outboxRows(env2).slice(before);
      assert.strictEqual(rows.length, 12);
      assert.ok(rows.every((r) => /:k\d+$/.test(r.k)), rows[0].k);
      const pulse = (victimId, atMs = day0 + 100) => env2.standings.onNpcKill({ characterId: 9,
        victimFactionId: GURISTAS, systemId: SYS.N5, atMs, victimId }).outcome;
      assert.deepStrictEqual([pulse(101), pulse(102), pulse(103), pulse(101)],
        ["GRANTED", "GRANTED", "GRANTED", "DEBOUNCED"]);
      assert.strictEqual(pulse(999, day0), "DEBOUNCED", "the legacy key of the same kill");
      assert.ok(outboxRows(env2).slice(-3).every((r) => /:k\d+\.10[123]$/.test(r.k)));
      env2.standings.stop("test");
    }));

  test("S4 flag: default on; off -> disabled_by_config, no handler, zero write calls; loader hook parity", () => {
    assert.strictEqual(configOf().standings.enabled, true, "on by default");
    assert.strictEqual(isStandingsEnabled(configOf()), true);
    const rt = fakeRuntime();
    const adapter = fakeAdapter(rt);
    let registered = 0;
    const r = startStandings({ config: configOf({ EVEJS_LNE_STANDINGS_ENABLED: "false" }), persistence: null,
      clock: { now: () => 0 }, scheduler: { registerHandler: () => { registered += 1; return { ok: true }; } },
      adapter });
    assert.deepStrictEqual([r.ok, r.reason, registered], [false, "disabled_by_config", 0]);
    killObservation.setLiberation(null);
    assert.strictEqual(killObservation.getStandings(), null);
    const wrap = killObservation.wrapNpcKillStandingLoss(() => ({ applied: true }),
      { resolveVictimFactionID: () => GURISTAS });
    assert.deepStrictEqual(wrap.wrapped({}, 7, { nowMs: 1, systemID: 30000001 }), { applied: true });
    assert.strictEqual(adapter.spy.writes, 0, "flag off -> zero write calls");

    const { buildHooks } = require("../../loader");
    const silent = { log() {}, debug() {}, logError() {} };
    const wraps = (config) => {
      const ctx = { logger: silent, state: { configResult: { ok: true, config } } };
      const hook = buildHooks(ctx).find((h) => h.name === "npcKillLiberation");
      const original = () => null;
      const exportsObj = { recordNpcFactionStandingLoss: original, resolveVictimFactionID: () => 0 };
      hook.run(exportsObj, "factionKillStandingRuntime", null);
      return exportsObj.recordNpcFactionStandingLoss !== original;
    };
    const mods = (over = {}) => ({ world: { enabled: true }, scheduler: { enabled: true },
      persistence: { enabled: true }, ...over });
    const on = { enabled: true, modules: mods(), occupation: { enabled: true }, liberation: { enabled: false },
      standings: { enabled: true } };
    const cases = [on, { ...on, enabled: false }, { ...on, standings: { enabled: false } },
      { ...on, modules: mods({ scheduler: { enabled: false } }) }, { ...on, modules: mods({ persistence: {
        enabled: false } }) }, { ...on, modules: mods({ world: { enabled: false } }) }, { ...on, standings: undefined }];
    for (const c of cases) assert.strictEqual(wraps(c), isStandingsEnabled(c), JSON.stringify(c));
    assert.strictEqual(wraps(on), true, "standings on + liberation off -> wrapped");
    assert.strictEqual(wraps({ ...on, standings: { enabled: false } }), false, "both off -> no wrap");
    assert.strictEqual(wraps({ ...on, enabled: false }), false, "master off -> no wrap");
  });

  needsDriver("S6 failures never break the game: a throwing listener, a throwing vendor (transient, event returns)",
    () => H.withStore(driver, async (reopen) => {
      const seen = [];
      killObservation.setLiberation({ onNpcKill(k) { seen.push(k); return { ok: true }; } });
      killObservation.setStandings({ onNpcKill() { throw new Error("standings boom"); } });
      const wrap = killObservation.wrapNpcKillStandingLoss(() => ({ applied: true, v: 1 }),
        { resolveVictimFactionID: () => GURISTAS });
      assert.deepStrictEqual(wrap.wrapped({}, 7, { nowMs: 3, systemID: 30000001 }), { applied: true, v: 1 });
      assert.strictEqual(seen.length, 1, "liberation still got the kill");
      const out = killObservation.observeKill(null, {}, 7, { nowMs: 3, systemID: 30000001 },
        { resolveVictimFactionID: () => GURISTAS, getLiberation: killObservation.getLiberation,
          getStandings: killObservation.getStandings });
      assert.strictEqual(out.results.standings.reason, "LISTENER_THREW");
      killObservation.setLiberation(null);
      killObservation.setStandings(null);

      const shared = H.sharedOf();
      const rt = fakeRuntime();
      const env = bootStd(reopen(), shared, {}, rt);
      seedSystem(env, SYS.N5, GURISTAS);
      const base = shared.clock.now();
      assert.strictEqual(env.standings.onNpcKill({ characterId: 7, victimFactionId: GURISTAS, systemId: SYS.N5,
        atMs: base }).outcome, "GRANTED");
      rt.throwNext = true;
      const h = env.handler(evOf(grantEvents(env)[0]), { now: base });
      assert.deepStrictEqual([h.ok, h.reason], [false, "STANDING_THREW"]);
      await passesAt(env, shared, base);
      const ev = grantEvents(env)[0];
      assert.ok(ev.state !== "DONE" && ev.attempts === 1, JSON.stringify(ev));
      assert.strictEqual(outboxRows(env)[0].state, "PENDING");
      rt.throwNext = false;
      env.standings.stop("test");
    }));
};

Object.assign(module.exports, { harness: Object.freeze({ bootStd, seedSystem, fakeRuntime, outboxRows, grantEvents, evOf,
  passesAt, CALDARI, GURISTAS }) });
