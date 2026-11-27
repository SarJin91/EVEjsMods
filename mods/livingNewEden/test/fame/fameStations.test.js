"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { fameSettingsOf } = require("../../lib/fame/schema");
const { createFameService } = require("../../lib/fame/service");
const { startLoyalty } = require("../../lib/loyalty");
const { marketModifierOf, applyMarketModifier } = require("../../lib/fame/market");
const { createDockGateHook } = require("../../lib/adapter/dockGate");
const fameMarketHook = require("../../lib/adapter/fameMarketHook");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const AMARR = 500003;
const CALDARI = 500001;
const CHAR = 90000001;
const STATION = 60003760;
const SYSTEM = 30000142;
const ALLOW = { deny: false };

function readSource(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function loyaltyConfig(loyaltyOn, fameDock) {
  return { loyalty: { dockDenyEnabled: loyaltyOn, dockDenyStandingMax: -5, dockDenyExemptCapsule: true },
    fame: { enabled: fameDock, dockDenyEnabled: fameDock } };
}

function stubAdapter(standing) {
  const calls = { install: 0 };
  return {
    calls,
    standing,
    dockGateSeams: () => ({ ok: true }),
    installDockGate: () => { calls.install += 1; return { ok: true }; },
    uninstallDockGate: () => ({ ok: true }),
    readCharacterStanding() { return this.standing; },
    readFactionNames: () => ({ ok: true, names: new Map([[AMARR, "Amarr Empire"]]) }),
  };
}

const cfgCache = new Map();
function fameSettings(env) {
  const key = JSON.stringify(env);
  if (!cfgCache.has(key)) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_FAME_ENABLED: "1", ...env }, settings: {}, envFile: {} });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    const s = fameSettingsOf(r.config);
    assert.strictEqual(s.ok, true, JSON.stringify(s));
    cfgCache.set(key, s.settings);
  }
  return cfgCache.get(key);
}

function fameService(env, standings, extra = {}) {
  return createFameService({ settings: fameSettings(env), store: {}, journal: {}, clock: { now: () => 1760000000000 },
    readStanding: (cid, fid) => ({ ok: true, found: true, standing: standings.get(`${cid}:${fid}`) || 0 }),
    readFactionNames: () => ({ ok: true, names: new Map([[CALDARI, "Caldari State"]]) }), ...extra });
}

const FAME_DENY = Object.freeze({ deny: true, factionId: CALDARI,
  message: "Caldari State security refuses docking to a declared public enemy." });

module.exports = ({ test }) => {
  test("FS1 loyalty.decide + fame rule: NO_CONTROLLER enemy deny, capsule, fail-open, fame off = today, both off", () => {
    const asked = [];
    let verdict = () => FAME_DENY;
    const fame = { dockVerdict: (q) => { asked.push(q); return verdict(q); } };
    const world = { getControllerMemo: () => ({ ok: true, controllerFactionId: null }) };
    const a = startLoyalty({ config: loyaltyConfig(false, true), ctx: { world, fame }, adapter: stubAdapter(null) });
    assert.strictEqual(a.loyalty.getStatus().state, "running", "fame dock alone installs the gate");
    const q = { characterId: CHAR, stationId: STATION, systemId: SYSTEM, isCapsule: false, stationFactionId: CALDARI };
    const rows = [
      [q, { deny: true, message: FAME_DENY.message }],
      [{ ...q, isCapsule: true }, ALLOW, () => ALLOW],
      [q, ALLOW, () => { throw new Error("boom"); }],
      [q, ALLOW, () => null],
    ];
    for (const [query, want, v] of rows) {
      verdict = v || (() => FAME_DENY);
      assert.deepStrictEqual(a.loyalty.decide(query), want, JSON.stringify(query));
    }
    assert.deepStrictEqual(asked[0], { characterId: CHAR, factionIds: [null, CALDARI], isCapsule: false });
    assert.strictEqual(asked[1].isCapsule, true, "the capsule is passed on (dockVerdict exempts it)");
    const c = a.loyalty.getStatus().counters;
    assert.deepStrictEqual([c.fameDockDenied, c.fameDockFailOpen, c.dockChecked, c.dockFailOpen], [1, 1, 4, 0]);
    const nf = startLoyalty({ config: loyaltyConfig(false, true), ctx: { world }, adapter: stubAdapter(null) });
    assert.deepStrictEqual(nf.loyalty.decide(q), ALLOW);
    assert.strictEqual(nf.loyalty.getStatus().counters.fameDockFailOpen, 1);

    const hostile = { getControllerMemo: () => ({ ok: true, controllerFactionId: AMARR }) };
    const today = [
      [{ ok: true, found: true, standing: -6.5 }, hostile, q, { deny: true, message: "Amarr Empire controls this "
        + "system and refuses docking to pilots with standing -5 or lower (yours: -6.50)." }],
      [{ ok: true, found: true, standing: -6.5 }, hostile, { ...q, isCapsule: true }, ALLOW],
      [{ ok: false, reason: "SEAM_UNAVAILABLE" }, hostile, q, ALLOW],
      [{ ok: true, standing: -1 }, hostile, q, ALLOW],
      [{ ok: true, standing: -9 }, { getControllerMemo: () => ({ ok: true, controllerFactionId: null }) }, q, ALLOW],
      [{ ok: true, standing: -9 }, { getControllerMemo: () => { throw new Error("boom"); } }, q, ALLOW],
    ];
    const spy = { dockVerdict: () => assert.fail("fame off: dockVerdict asked") };
    for (const [standing, w, query, want] of today) {
      const l = startLoyalty({ config: loyaltyConfig(true, false), ctx: { world: w, fame: spy },
        adapter: stubAdapter(standing) });
      assert.deepStrictEqual(l.loyalty.decide(query), want, JSON.stringify(standing));
      const cc = l.loyalty.getStatus().counters;
      assert.deepStrictEqual([cc.fameDockDenied, cc.fameDockFailOpen], [0, 0]);
    }
    asked.length = 0;
    verdict = () => FAME_DENY;
    const both = startLoyalty({ config: loyaltyConfig(true, true), ctx: { world: hostile, fame },
      adapter: stubAdapter({ ok: true, standing: -1 }) });
    assert.deepStrictEqual(both.loyalty.decide(q).deny, true);
    assert.deepStrictEqual(asked[0].factionIds, [AMARR, CALDARI]);
    const off = stubAdapter(null);
    const o = startLoyalty({ config: loyaltyConfig(false, false), ctx: { world, fame }, adapter: off });
    assert.deepStrictEqual([o.loyalty.getStatus().state, off.calls.install], ["off", 0]);

    const svc = fameService({ EVEJS_LNE_FAME_DOCK_DENY_ENABLED: "1" }, new Map([[`${CHAR}:${CALDARI}`, -3]]));
    assert.deepStrictEqual(svc.dockVerdict({ characterId: CHAR, factionIds: [null, AMARR, CALDARI, CALDARI],
      isCapsule: false }), FAME_DENY);
    assert.deepStrictEqual(svc.dockVerdict({ characterId: CHAR, factionIds: [CALDARI], isCapsule: true }), ALLOW);
    assert.deepStrictEqual(svc.dockVerdict({ characterId: CHAR, factionIds: "x", isCapsule: false }), ALLOW);
    assert.strictEqual(svc.getStatus().counters.dockDenied, 1);
    const noFlag = fameService({}, new Map([[`${CHAR}:${CALDARI}`, -3]]));
    assert.deepStrictEqual(noFlag.dockVerdict({ characterId: CHAR, factionIds: [CALDARI], isCapsule: false }), ALLOW);
  });

  test("FS2 fame market: LEGEND x0.8, PUBLIC_ENEMY x1.5, cap, no station = same object, broker behind its flag, "
    + "input frozen", () => {
    const p = { marketTaxEnabled: true, marketBrokerEnabled: false, legendTaxPermille: -200, enemyTaxPermille: 500,
      legendBrokerPermille: -100, enemyBrokerPermille: 300, maxSurchargePermille: 1000 };
    assert.deepStrictEqual(marketModifierOf("NONE", p), { taxPermille: 0, brokerPermille: 0 });
    assert.deepStrictEqual(marketModifierOf("LEGEND", p), { taxPermille: -200, brokerPermille: 0 });
    assert.deepStrictEqual(marketModifierOf("PUBLIC_ENEMY", { ...p, marketBrokerEnabled: true }),
      { taxPermille: 500, brokerPermille: 300 });
    assert.deepStrictEqual(marketModifierOf("PUBLIC_ENEMY", { ...p, marketTaxEnabled: false }),
      { taxPermille: 0, brokerPermille: 0 });
    const ctx = Object.freeze({ characterID: CHAR, isStation: true, station: Object.freeze({ factionID: CALDARI }),
      brokerCommissionRate: 0.03, limits: Object.freeze({ cnt: 5, acc: 0.08 }) });
    const near = (a, b) => Math.abs(a - b) < 1e-12;
    const legend = applyMarketModifier(ctx, marketModifierOf("LEGEND", p), p);
    assert.ok(near(legend.limits.acc, 0.064) && legend.limits.cnt === 5 && legend.brokerCommissionRate === 0.03);
    assert.notStrictEqual(legend.limits, ctx.limits);
    const enemy = applyMarketModifier(ctx, marketModifierOf("PUBLIC_ENEMY", p), p);
    assert.ok(near(enemy.limits.acc, 0.12), String(enemy.limits.acc));
    const capped = applyMarketModifier(ctx, { taxPermille: 500, brokerPermille: 0 }, { maxSurchargePermille: 200 });
    assert.ok(near(capped.limits.acc, 0.096), "cap at vendor x 1.2");
    assert.strictEqual(applyMarketModifier({ ...ctx, isStation: false }, { taxPermille: 500, brokerPermille: 0 }, p)
      .limits.acc, 0.08);
    const notStation = Object.freeze({ ...ctx, isStation: false });
    assert.strictEqual(applyMarketModifier(notStation, { taxPermille: 500, brokerPermille: 0 }, p), notStation);
    assert.strictEqual(applyMarketModifier(ctx, { taxPermille: 0, brokerPermille: 0 }, p), ctx, "0/0 -> same object");
    const broker = applyMarketModifier(ctx, marketModifierOf("LEGEND", { ...p, marketBrokerEnabled: true }), p);
    assert.ok(near(broker.brokerCommissionRate, 0.027) && near(broker.limits.acc, 0.064));
    assert.deepStrictEqual([ctx.limits.acc, ctx.brokerCommissionRate], [0.08, 0.03], "input untouched");
    const nan = Object.freeze({ ...ctx, limits: Object.freeze({ acc: "x" }) });
    assert.strictEqual(applyMarketModifier(nan, { taxPermille: 500, brokerPermille: 0 }, p), nan, "not finite");

    let wrapper = { failOpen: 3 };
    const svc = fameService({ EVEJS_LNE_FAME_MARKET_TAX_ENABLED: "1" }, new Map([[`${CHAR}:${CALDARI}`, -3]]),
      { getMarketStatus: () => wrapper });
    assert.ok(near(svc.marketSlot(ctx).limits.acc, 0.12));
    assert.strictEqual(svc.marketSlot(notStation), notStation);
    wrapper = { failOpen: 5 };
    const st = svc.getStatus().counters;
    assert.deepStrictEqual([st.marketModified, st.marketNoStation, st.marketFailOpen], [1, 1, 2]);
    const many = fameService({ EVEJS_LNE_FAME_REVIEW_MAX_READS_PER_PASS: "64" }, new Map(), {
      getPresence: () => ({ listPresence: () => [{ systemId: SYSTEM, characters: [{ characterId: CHAR }] }] }),
      getRegistry: () => ({ listActiveFactions: () => Array.from({ length: 65 }, (_, i) => ({ factionId: 500001 + i })) }),
    });
    assert.deepStrictEqual(many.reviewNow(1760000000000), { ok: true, players: 0, reads: 0, announced: 0 });
    assert.strictEqual(many.getStatus().counters.readBudgetShort, 1);
  });

  test("FS3 dockGate.verdictFor: no stationFactionOf -> null, the gate works; a throwing one -> null", () => {
    const asked = [];
    class FakeBeyonce {}
    FakeBeyonce.prototype.Handle_CmdDock = () => "vendor";
    const base = { worldData: { getStationByID: (id) => (id === STATION ? { solarSystemID: SYSTEM } : null) },
      itemStore: { findItemById: () => null, isCapsuleTypeID: () => false },
      throwUserError: () => assert.fail("no deny"), decide: (q) => { asked.push(q.stationFactionId); return ALLOW; } };
    const session = { characterID: CHAR, shipTypeID: 587 };
    for (const stationFactionOf of [undefined, () => { throw new Error("boom"); }, () => CALDARI, () => "x"]) {
      class Cls extends FakeBeyonce {}
      Cls.prototype.Handle_CmdDock = function Handle_CmdDock() { return "vendor"; };
      const hook = createDockGateHook({ ...base, serviceClass: Cls, stationFactionOf });
      assert.deepStrictEqual(hook.install(), { ok: true });
      assert.strictEqual(new Cls().Handle_CmdDock([STATION], session), "vendor");
      assert.strictEqual(hook.getStats().failOpen, 0);
      hook.uninstall();
    }
    assert.deepStrictEqual(asked, [null, null, CALDARI, null]);

    const adapterSrc = readSource(path.join(MOD_DIR, "lib", "adapter", "index.js"));
    assert.ok(adapterSrc.includes("stationFactionOf: opts.stationFaction === true ? seams.seam.stationFactionOf : null,"),
      "adapter wiring of the station faction");
    let read = 0;
    const counted = () => { read += 1; return CALDARI; };
    for (const [on, want, wantRead] of [[false, null, 0], [true, CALDARI, 1]]) {
      class Cls extends FakeBeyonce {}
      Cls.prototype.Handle_CmdDock = function Handle_CmdDock() { return "vendor"; };
      asked.length = 0;
      read = 0;
      const hook = createDockGateHook({ ...base, serviceClass: Cls, stationFactionOf: on ? counted : null });
      hook.install();
      new Cls().Handle_CmdDock([STATION], session);
      hook.uninstall();
      assert.deepStrictEqual([asked[0], read], [want, wantRead], `stationFaction ${on}`);
    }
    const opts = [];
    for (const [loyaltyOn, fameDock] of [[true, false], [false, true], [true, true]]) {
      const ad = { ...stubAdapter(null), installDockGate: (o) => { opts.push(o.stationFaction); return { ok: true }; } };
      startLoyalty({ config: loyaltyConfig(loyaltyOn, fameDock), ctx: { world: {}, fame: {} }, adapter: ad });
    }
    assert.deepStrictEqual(opts, [false, true, true], "loyalty asks for the station faction only with fame dock");
  });

  test("FS4 vendor facts: getMarketContext fields, computeSalesTaxAmount reads limits.acc, marketProxyService "
    + "destructures getMarketContext, stationStaticData exports getStationRecord", () => {
    const rules = readSource(path.join(SERVER_SRC, "services", "market", "marketRules.js"));
    assert.ok(rules.includes("\nfunction getMarketContext({ characterID, stationID, session } = {}) {"));
    assert.ok(rules.includes("    brokerCommissionRate,\n"), "brokerCommissionRate in the result");
    assert.ok(rules.includes("      acc: transactionTaxRate,\n"), "limits.acc = the sales tax");
    assert.ok(rules.includes("    isStation,\n") && rules.includes("    station,\n"), "isStation, station");
    const tax = rules.slice(rules.indexOf("\nfunction computeSalesTaxAmount("));
    assert.ok(tax.slice(0, tax.indexOf("\n}\n")).includes("context.limits.acc"), "computeSalesTaxAmount reads acc");
    assert.ok(/module\.exports = \{[^}]*\n\s*getMarketContext,/.test(rules), "export literal");
    const proxy = readSource(path.join(SERVER_SRC, "services", "market", "marketProxyService.js"));
    assert.ok(/const \{[^}]*\n\s*getMarketContext,\n[^}]*\} = require\(path\.join\(__dirname, "\.\/marketRules"\)\);/
      .test(proxy), "destructured at the first require (FIRST_LOAD)");
    const station = readSource(path.join(SERVER_SRC, "services", "_shared", "stationStaticData.js"));
    assert.ok(station.includes("\nfunction getStationRecord(session = null, overrideStationID = null) {"));
    assert.ok(/module\.exports = \{[^}]*\n\s*getStationRecord,/.test(station), "getStationRecord exported");
  });

  test("FS5 fameMarketHook: empty slot -> same object, throwing slot -> original + failOpen, copy, frozen exports, "
    + "second install", () => {
    const vendorOut = { isStation: true, limits: { acc: 0.08 } };
    const exportsObj = { getMarketContext: function vendor(arg) { return arg === "x" ? vendorOut : null; },
      computeSalesTaxAmount: () => 0 };
    assert.deepStrictEqual(fameMarketHook.install(exportsObj), { ok: true, installed: true });
    assert.deepStrictEqual(fameMarketHook.install(exportsObj), { ok: true, installed: true, alreadyInstalled: true });
    fameMarketHook.setSlot(null);
    assert.strictEqual(exportsObj.getMarketContext("x"), vendorOut, "empty slot -> the vendor object");
    const before = fameMarketHook.getStatus().failOpen;
    fameMarketHook.setSlot(() => { throw new Error("boom"); });
    assert.strictEqual(exportsObj.getMarketContext("x"), vendorOut);
    assert.strictEqual(fameMarketHook.getStatus().failOpen, before + 1);
    const copy = { ...vendorOut, limits: { acc: 0.1 } };
    fameMarketHook.setSlot(() => copy);
    assert.strictEqual(exportsObj.getMarketContext("x"), copy);
    fameMarketHook.setSlot(() => 42);
    assert.strictEqual(exportsObj.getMarketContext("x"), vendorOut, "a non-object answer -> the vendor object");
    fameMarketHook.setSlot(null);
    assert.deepStrictEqual(vendorOut, { isStation: true, limits: { acc: 0.08 } }, "vendor result untouched");
    assert.deepStrictEqual(fameMarketHook.install(Object.freeze({ getMarketContext() {}, computeSalesTaxAmount() {} })),
      { ok: false, reason: "SEAM_NOT_WRITABLE" });
    assert.deepStrictEqual(fameMarketHook.setSlot("x"), { ok: false, reason: "SLOT_INVALID" });
  });

  test("FS6 fameMarketHook state: not_loaded, refused:PRIMARY_MISSING, refused:SEAM_NOT_WRITABLE, installed", () => {
    const file = require.resolve("../../lib/adapter/fameMarketHook");
    const kept = require.cache[file];
    delete require.cache[file];
    try {
      const fresh = require("../../lib/adapter/fameMarketHook");
      assert.notStrictEqual(fresh, fameMarketHook);
      const stateOf = () => fresh.getStatus().state;
      assert.strictEqual(stateOf(), "not_loaded");
      assert.deepStrictEqual(fresh.install({}), { ok: false, reason: "PRIMARY_MISSING" });
      assert.strictEqual(stateOf(), "refused:PRIMARY_MISSING");
      fresh.install(Object.freeze({ getMarketContext() {} }));
      assert.strictEqual(stateOf(), "refused:SEAM_NOT_WRITABLE");
      assert.deepStrictEqual(fresh.install({ getMarketContext: () => ({}) }), { ok: true, installed: true });
      const st = fresh.getStatus();
      assert.deepStrictEqual(st, { installed: true, slot: false, calls: 0, modified: 0, failOpen: 0,
        state: "installed" }, "the FS5 fields kept, refused cleared");
    } finally {
      require.cache[file] = kept;
    }
  });

  test("FS7 fame status/log: market=on(hook=...), live getStatus().market, a throwing read, flags off", () => {
    const { startFame } = require("../../lib/fame");
    const start = (env, getMarketStatus) => {
      const lines = [];
      const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
        EVEJS_LNE_FAME_ENABLED: "1", ...env }, settings: {}, envFile: {} });
      assert.strictEqual(r.ok, true);
      const s = startFame({ config: r.config, clock: { now: () => 1760000000000 }, logger: { log: (l) => lines.push(l) },
        persistence: { ok: true, store: {}, journal: {} }, readStanding: () => ({ ok: true, standing: 0 }),
        setTimer: () => ({ cancel() {}, hasRef: () => false }), setMarketSlot: () => {}, getMarketStatus });
      assert.strictEqual(s.ok, true, JSON.stringify(s));
      return { fame: s.fame, line: lines.find((l) => l.startsWith("fame: running")) };
    };
    let hook = { state: "installed", installed: true, slot: true, calls: 3, modified: 1, failOpen: 0 };
    const on = start({ EVEJS_LNE_FAME_MARKET_TAX_ENABLED: "1" }, () => hook);
    assert.ok(on.line.endsWith(" market=on(hook=installed)"), on.line);
    assert.deepStrictEqual(on.fame.getStatus().market,
      { state: "installed", installed: true, slot: true, calls: 3, modified: 1 });
    hook = { ...hook, calls: 5, modified: -1 };
    assert.deepStrictEqual([on.fame.getStatus().market.calls, on.fame.getStatus().market.modified], [5, 0], "live");
    on.fame.stop();

    const thr = start({ EVEJS_LNE_FAME_MARKET_BROKER_ENABLED: "1" }, () => { throw new Error("boom"); });
    assert.ok(thr.line.endsWith(" market=on(hook=unknown)"), thr.line);
    assert.deepStrictEqual(thr.fame.getStatus().market,
      { state: "unknown", installed: false, slot: false, calls: 0, modified: 0 });
    thr.fame.stop();

    let asked = 0;
    const off = start({}, () => { asked += 1; return hook; });
    assert.ok(off.line.endsWith(" market=off"), off.line);
    assert.strictEqual(off.fame.getStatus().market, null);
    assert.strictEqual(asked, 0, "flags off -> getMarketStatus never read");
    off.fame.stop();
  });
};
