"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { probeModules } = require("../../lib/adapter/probe");
const seams = require("../../lib/adapter/sentrySeams");
const T = require("../../lib/adapter/data/sentryTypes");
const { startSentries } = require("../../lib/sentries");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const SRC = path.resolve(path.sep, "fake", "server", "src");
const DEF_FILE = path.join(SRC, "services", "starbase", "starbaseDefenseRuntime.js");
const REG_FILE = path.join(SRC, "services", "inventory", "itemTypeRegistry.js");
const POLICY = Object.freeze({ anchor: () => ({ success: true }), online: () => ({ success: true }),
  isArmed: () => false });

const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: MOD_DIR, ...env } });
const lookWarnings = (r) => r.warnings.filter((w) => w.includes("lookTypeId") || w.includes("lookMode"));

module.exports = ({ test, skip }) => {
  test("HSL1 hydrateBatteryActor wrap: heavy + look -> slim fields after the original; other types / no look "
    + "unchanged; frozen entity skipped; 2nd install alreadyInstalled", () => {
    seams.resetForTests();
    const order = [];
    const fixture = { hydrateBatteryActor(entity) {
      order.push(["original", entity && entity.slimGraphicID]);
      if (entity && Object.isExtensible(entity)) entity.hydrated = true;
      return entity;
    } };
    const original = fixture.hydrateBatteryActor;
    const first = seams.installDefensePresentation(fixture, { cache: {}, filename: DEF_FILE });
    assert.deepStrictEqual(first, { ok: true, installed: ["hydrateBatteryActor"], alreadyInstalled: false });
    assert.notStrictEqual(fixture.hydrateBatteryActor, original);
    const hydrate = (typeID) => {
      const entity = { typeID };
      const r = fixture.hydrateBatteryActor(entity, { typeID });
      assert.strictEqual(r, entity, "the result of the original");
      return entity;
    };
    assert.deepStrictEqual(hydrate(340522), { typeID: 340522, hydrated: true }, "no bind = no look");
    seams.bindPolicy(POLICY, { look: { typeIds: [340522], graphicID: 2222, slimTypeID: null } });
    order.length = 0;
    assert.deepStrictEqual(hydrate(340522), { typeID: 340522, hydrated: true, slimGraphicID: 2222 });
    assert.deepStrictEqual(order, [["original", undefined]], "the original first");
    for (const typeID of [340500, 340520, 16689]) {
      assert.deepStrictEqual(hydrate(typeID), { typeID, hydrated: true }, String(typeID));
    }
    seams.bindPolicy(POLICY, { look: { typeIds: [340522], graphicID: 2222, slimTypeID: 3740 } });
    assert.deepStrictEqual(hydrate(340522), { typeID: 340522, hydrated: true, slimGraphicID: 2222, slimTypeID: 3740 });
    const frozen = Object.freeze({ typeID: 340522 });
    assert.doesNotThrow(() => fixture.hydrateBatteryActor(frozen, { typeID: 340522 }));
    assert.deepStrictEqual(seams.createSentrySeam({}).lookStats(), { applied: 2, skipped: 1 });
    seams.bindPolicy(POLICY, { look: null });
    assert.deepStrictEqual(hydrate(340522), { typeID: 340522, hydrated: true }, "look null");
    seams.bindPolicy(POLICY, { look: { typeIds: [340522], graphicID: 2222, slimTypeID: null } });
    seams.bindPolicy(null);
    assert.deepStrictEqual(hydrate(340522), { typeID: 340522, hydrated: true }, "bindPolicy(null)");
    assert.deepStrictEqual(seams.installDefensePresentation(fixture, { cache: {}, filename: DEF_FILE }),
      { ok: true, installed: [], alreadyInstalled: true });
    assert.strictEqual(seams.installState().defensePresentation, "already_installed");
    seams.resetForTests();
  });

  test("HSL2 resolveLookType from the module cache: ok / NOT_FOUND / NO_GRAPHIC / INVALID_INPUT / SEAM_MISSING; "
    + "the real frozen facade has resolveLookType and lookStats", () => {
    seams.resetForTests();
    const types = new Map([[3740, { typeID: 3740, graphicID: 1212, groupID: 99, categoryID: 11 }],
      [3742, { typeID: 3742, groupID: 99, categoryID: 11 }]]);
    const registry = { resolveItemByTypeID: (id) => types.get(id) || null };
    seams.installDefensePresentation({ hydrateBatteryActor: () => null },
      { cache: { [REG_FILE]: { exports: registry } }, filename: DEF_FILE });
    const facade = seams.createSentrySeam({ requireGame: () => ({ ok: false, reason: "test" }) });
    assert.ok(Object.isFrozen(facade));
    assert.deepStrictEqual([typeof facade.resolveLookType, typeof facade.lookStats], ["function", "function"]);
    assert.deepStrictEqual(facade.resolveLookType(3740), { ok: true, graphicID: 1212, groupID: 99, categoryID: 11 });
    assert.deepStrictEqual([3739, 3742, 16689].map((id) => facade.resolveLookType(id).reason),
      ["NOT_FOUND", "NO_GRAPHIC", "INVALID_INPUT"]);
    seams.resetForTests();
    seams.installDefensePresentation({ hydrateBatteryActor: () => null }, { cache: {}, filename: DEF_FILE });
    assert.strictEqual(seams.createSentrySeam({}).resolveLookType(3740).reason, "SEAM_MISSING");
    seams.resetForTests();
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("HSL3 startSentries look: 3740 ok -> bind look.graphicID; 0 -> null; 9999 -> null + lookRefused; "
    + "optional defensePresentation -> null + lookRefused; heavy off -> null, no lookRefused",
  () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const run = (heavy, optional = {}) => {
      const shared = H.sharedOf();
      const se = DEFAULTS.sentries;
      const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
        sentries: { ...se, enabled: true, heavy: { ...se.heavy, enabled: true, ...heavy } } };
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock: shared.clock,
        ids: shared.ids, nowMs: () => 0 });
      assert.ok(sr.ok, JSON.stringify(sr));
      const real = seams.createSentrySeam({ requireGame: () => ({ ok: false, reason: "test" }) });
      const seam = { ...real,
        resolveLookType: (id) => (id === 3740 ? { ok: true, graphicID: 1212, groupID: 99, categoryID: 11 }
          : { ok: false, reason: "NOT_FOUND" }) };
      let bound = null;
      const adapter = { sentrySeams: () => ({ ok: true, seam, optional }),
        bindSentryPolicy: (p, opts) => {
          if (p !== null) bound = opts;
          return { ok: true };
        } };
      const started = startSentries({ config: cfg, persistence: { ok: true, store: opened.store, journal },
        clock: shared.clock, scheduler: sr.scheduler, adapter,
        graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "lowsec" }) } }) } });
      assert.ok(started.ok, JSON.stringify(started));
      const out = { look: bound.look, refused: started.service.getStatus().counters.lookRefused,
        status: started.sentries.getStatus().look };
      started.sentries.stop("test");
      return out;
    };
    const ok = run({});
    assert.deepStrictEqual(ok.look, { typeIds: [340522, 340523, 340524, 340525], graphicID: 1212, slimTypeID: null });
    assert.deepStrictEqual([ok.refused, ok.status], [0, { typeId: 3740, mode: "graphic", applied: 0, skipped: 0 }]);
    assert.strictEqual(run({ lookMode: "type" }).look.slimTypeID, 3740);
    const zero = run({ lookTypeId: 0 });
    assert.deepStrictEqual([zero.look, zero.refused, zero.status], [null, 0, null]);
    const notCandidate = run({ lookTypeId: 9999 });
    assert.deepStrictEqual([notCandidate.look, notCandidate.refused], [null, 1]);
    const wrapOff = run({}, { defensePresentation: "refused" });
    assert.deepStrictEqual([wrapOff.look, wrapOff.refused], [null, 1]);
    const off = run({ enabled: false });
    assert.deepStrictEqual([off.look, off.refused], [null, 0]);
  }));

  test("HSL4 config: W154 (9999), W155 (explicit 3740, heavy off), no look warning on the defaults with the heavy "
    + "flag; lookMode x refused by the check", () => {
    assert.deepStrictEqual([DEFAULTS.sentries.heavy.lookTypeId, DEFAULTS.sentries.heavy.lookMode], [3740, "graphic"]);
    assert.deepStrictEqual(lookWarnings(resolve({ EVEJS_LNE_SENTRIES_HEAVY_ENABLED: "1",
      EVEJS_LNE_SENTRIES_HEAVY_LOOK_TYPE_ID: "9999" })),
    ["sentries.heavy.lookTypeId 9999 is not 1194 or 3739-3743 - look off, battery look stays"]);
    assert.deepStrictEqual(lookWarnings(resolve({ EVEJS_LNE_SENTRIES_HEAVY_LOOK_TYPE_ID: "3740" })),
      ["sentries.heavy.lookTypeId without sentries.heavy.enabled - no effect"]);
    assert.deepStrictEqual(lookWarnings(resolve({ EVEJS_LNE_SENTRIES_HEAVY_ENABLED: "1" })), []);
    assert.deepStrictEqual(lookWarnings(resolve({})), [], "the defaults (heavy off, look default)");
    for (const id of T.LOOK_CANDIDATES) {
      assert.deepStrictEqual(lookWarnings(resolve({ EVEJS_LNE_SENTRIES_HEAVY_ENABLED: "1",
        EVEJS_LNE_SENTRIES_HEAVY_LOOK_TYPE_ID: String(id) })), [], String(id));
    }
    const mode = resolve({ EVEJS_LNE_SENTRIES_HEAVY_LOOK_MODE: "x" });
    assert.strictEqual(mode.config.sentries.heavy.lookMode, "graphic");
    assert.ok(mode.warnings.some((w) => w.includes("LOOK_MODE") && w.includes("is not graphic or type")),
      JSON.stringify(mode.warnings));
  });

  test("HSL5 vendor facts of the look + probe: no resolveItemByTypeID -> disabledModules.sentryLook, not sentries", () => {
    const found = findServerSrcOnDisk(MOD_DIR, 5, fs.existsSync);
    assert.ok(found.ok, "EveJS server/src not found above the mod");
    const read = (rel) => fs.readFileSync(path.join(found.srcDir, `${rel}.js`), "utf8").replace(/\r\n/g, "\n");
    const ise = read("space/runtime/inventorySpaceEntity");
    const def = read("services/starbase/starbaseDefenseRuntime");
    const problems = [];
    if (!ise.includes("starbaseDefenseRuntime.hydrateBatteryActor(entity, resolved)")) problems.push("hydrate :567");
    if (!read("space/destiny/index").includes("entries.push([\"graphicID\", slimGraphicID]);")) problems.push("destiny");
    if (!ise.includes("entity.graphicID = toInt(metadata && metadata.graphicID, 0) || null;")
      || /entity\.slimGraphicID\s*=/.test(ise)) problems.push("refresh writes graphicID, not slimGraphicID");
    if (!/module\.exports = \{[^}]*\bhydrateBatteryActor\b[^}]*\}/.test(def)) problems.push("module.exports");
    for (const dir of [path.join("services", "starbase"), path.join("space", "runtime")]) {
      const stack = [path.join(found.srcDir, dir)];
      while (stack.length > 0) {
        const at = stack.pop();
        for (const e of fs.readdirSync(at, { withFileTypes: true })) {
          const p = path.join(at, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.name.endsWith(".js") && /\{\s*hydrateBatteryActor/.test(fs.readFileSync(p, "utf8"))) {
            problems.push(`destructured in ${path.relative(found.srcDir, p)}`);
          }
        }
      }
    }
    assert.deepStrictEqual(problems, []);
    const table = GAME_MODULES.filter((e) => ["services/inventory/itemTypeRegistry",
      "services/starbase/starbaseDefenseRuntime"].includes(e.path));
    const r = probeModules(table, { load: (p) => {
      const exportsOf = {};
      for (const s of table.find((e) => e.path === p).symbols) {
        if (s.name !== "resolveItemByTypeID") exportsOf[s.name] = () => null;
      }
      return { ok: true, exports: exportsOf };
    } });
    assert.ok(Object.prototype.hasOwnProperty.call(r.disabledModules, "sentryLook"), JSON.stringify(r.disabledModules));
    assert.ok(!Object.prototype.hasOwnProperty.call(r.disabledModules, "sentries"), JSON.stringify(r.disabledModules));
    const sym = table.find((e) => e.path === "services/starbase/starbaseDefenseRuntime").symbols
      .find((s) => s.name === "hydrateBatteryActor");
    assert.deepStrictEqual([sym.consumers, sym.wrap, sym.firstLoad], [["sentries", "sentryLook"], true, true]);
  });
};
