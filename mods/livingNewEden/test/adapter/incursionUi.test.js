"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const NodeModule = require("node:module");

const { createAdapter } = require("../../lib/adapter");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { RUNTIME_PATH, RUNTIME_SHA1, createIncursionUiPublisher } = require("../../lib/adapter/incursionUi");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const RUNTIME_FILE = path.join(SERVER_SRC, ...`${RUNTIME_PATH}.js`.split("/"));
const MAP_FILE = path.join(SERVER_SRC, "services", "map", "mapService.js");

function readSource(abs) {
  return fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
}

function loadVendorRuntime(presentation) {
  const mod = { exports: {} };
  const fakeRequire = (id) => {
    if (id === "./incursionPresentation") return presentation;
    if (id === "../../common/clone") return require(path.join(SERVER_SRC, "common", "clone.js"));
    throw new Error(`unexpected require ${id}`);
  };
  vm.runInThisContext(NodeModule.wrap(fs.readFileSync(RUNTIME_FILE, "utf8")), { filename: RUNTIME_FILE })(
    mod.exports, fakeRequire, mod, RUNTIME_FILE, path.dirname(RUNTIME_FILE));
  return mod.exports;
}

function presentationOf(list) {
  return { activeTales: () => list.current, report: (tale) => JSON.parse(JSON.stringify(tale)) };
}

function vendorEntry(over) {
  return { taleID: 8000000000000, stagingSolarSystemID: 30000142, systems: [{ locationID: 30000144 }],
    incursedSystems: [30000145], aggressorFactionID: 500019, ...over };
}

function lneEntry(round, systemId) {
  return { taleID: 9000000000001 + round, stagingSolarSystemID: systemId, aggressorFactionID: 500021,
    systems: [{ solarSystemID: systemId, sceneType: 4, templateNameID: 0 }], incursedSystems: [] };
}

function core(runtime, overrides) {
  const files = { [RUNTIME_FILE]: readSource(RUNTIME_FILE), [MAP_FILE]: readSource(MAP_FILE), ...overrides };
  return createIncursionUiPublisher({
    requireGame: (rel) => (rel === RUNTIME_PATH ? { ok: true, exports: runtime } : { ok: false, reason: "x" }),
    serverSrc: () => SERVER_SRC,
    readFile: (abs) => (Object.prototype.hasOwnProperty.call(files, abs) ? files[abs] : null),
  });
}

module.exports = ({ test, skip }) => {
  const haveSrc = fs.existsSync(RUNTIME_FILE) && fs.existsSync(MAP_FILE);

  const ia1 = "IA1 publishIncursions on the real facade: vendor + LNE, fresh copies, [] -> same array, throw passes";
  if (!haveSrc) skip(ia1, "server/src not found");
  else {
    test(ia1, () => {
      const blind = createAdapter({ moduleApi: { _cache: {} } });
      assert.strictEqual(blind.publishIncursions([]).ok, true, "empty publish before install: nothing to do");
      blind.setServerSrc(SERVER_SRC);
      assert.strictEqual(blind.publishIncursions([{}]).reason, "INCURSION_RUNTIME_UNAVAILABLE", "not cached");

      const vendorList = { current: [vendorEntry()] };
      const runtime = loadVendorRuntime(presentationOf(vendorList));
      const original = runtime.listActiveIncursions;
      const adapter = createAdapter({ moduleApi: { _cache: { [RUNTIME_FILE]: { exports: runtime } } } });
      adapter.setServerSrc(SERVER_SRC);
      assert.strictEqual(typeof adapter.incursionUiStats, "function");
      const lne = lneEntry(7, 30001867);
      assert.deepStrictEqual(adapter.publishIncursions([lne]), { ok: true, count: 1 });
      assert.notStrictEqual(runtime.listActiveIncursions, original, "export swapped");
      const first = runtime.listActiveIncursions();
      assert.deepStrictEqual(first, [vendorEntry(), lne]);
      first[1].stagingSolarSystemID = 1;
      first.push({ junk: true });
      assert.deepStrictEqual(runtime.listActiveIncursions(), [vendorEntry(), lne], "a mutated result spoils nothing");
      assert.deepStrictEqual(adapter.publishIncursions("x"), { ok: false, reason: "INVALID_LIST" });
      assert.deepStrictEqual(adapter.publishIncursions([lne]), { ok: true, count: 1 }, "second publish: no reinstall");
      assert.strictEqual(adapter.incursionUiStats().installed, true);

      assert.deepStrictEqual(adapter.publishIncursions([]), { ok: true, count: 0 });
      const fixed = [vendorEntry()];
      vendorList.current = fixed;
      const viaWrapper = runtime.listActiveIncursions();
      assert.deepStrictEqual(viaWrapper, fixed, "transparent after publish([])");
      const passthrough = loadVendorRuntime({ activeTales: () => ({ map: () => fixed }), report: (t) => t });
      const c = core(passthrough);
      assert.deepStrictEqual(c.publish([lne]), { ok: true, count: 1 });
      assert.deepStrictEqual(c.publish([]), { ok: true, count: 0 });
      assert.strictEqual(passthrough.listActiveIncursions(), fixed, "no LNE entries -> the same vendor array");

      vendorList.current = null;
      assert.throws(() => runtime.listActiveIncursions(), TypeError, "a vendor throw passes through");

      const entries = GAME_MODULES.filter((m) => m.path === RUNTIME_PATH);
      assert.strictEqual(entries.length, 1);
      assert.deepStrictEqual(entries[0].symbols.map((s) => [s.name, s.kind, s.wrap, [...s.consumers]]),
        [["listActiveIncursions", "export", true, ["incursionUi"]]]);
    });
  }

  const ia2 = "IA2 vendor facts: incursionRuntime SHA-1, mapService calls twice, no other caller, ID_BASE 8e12";
  if (!haveSrc) skip(ia2, "server/src not found");
  else {
    test(ia2, () => {
      const crypto = require("node:crypto");
      assert.strictEqual(crypto.createHash("sha1").update(readSource(RUNTIME_FILE)).digest("hex"), RUNTIME_SHA1);
      const map = readSource(MAP_FILE);
      assert.ok(map.includes("const incursionRuntime = require(path.join("), "mapService holds the module object");
      assert.strictEqual(map.split("incursionRuntime.listActiveIncursions()").length - 1, 2);
      const callers = [];
      const destructured = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) walk(abs);
          else if (e.name.endsWith(".js")) {
            const text = fs.readFileSync(abs, "utf8");
            if (!text.includes("listActiveIncursions")) continue;
            if (abs !== RUNTIME_FILE) callers.push(path.relative(SERVER_SRC, abs));
            if (/\{[^}]*\blistActiveIncursions\b[^}]*\}\s*=\s*require/.test(text)) destructured.push(abs);
          }
        }
      };
      walk(SERVER_SRC);
      assert.deepStrictEqual(callers, [path.join("services", "map", "mapService.js")]);
      assert.deepStrictEqual(destructured, []);
      const lifecycle = readSource(path.join(SERVER_SRC, "services", "incursion", "incursionLifecycle.js"));
      assert.ok(lifecycle.includes("const ID_BASE = 8000000000000;"), "vendor ID_BASE below the LNE base 9e12");
    });
  }

  const ia3 = "IA3 collisions: vendor staging / systems / incursedSystems / taleID -> LNE entry suppressed";
  if (!haveSrc) skip(ia3, "server/src not found");
  else {
    test(ia3, () => {
      const vendorList = { current: [vendorEntry()] };
      const runtime = loadVendorRuntime(presentationOf(vendorList));
      const c = core(runtime);
      const kept = lneEntry(1, 30001867);
      const cases = [lneEntry(2, 30000142), lneEntry(3, 30000144), lneEntry(4, 30000145),
        { ...lneEntry(5, 30002000), taleID: 8000000000000 }];
      for (const clash of cases) {
        assert.deepStrictEqual(c.publish([clash, kept]), { ok: true, count: 2 });
        assert.deepStrictEqual(runtime.listActiveIncursions(), [vendorEntry(), kept], JSON.stringify(clash));
        assert.strictEqual(c.stats().lastSuppressed, 1);
      }
      assert.strictEqual(c.stats().merged, cases.length);
    });
  }

  const ia4 = "IA4 DRIFT: changed incursionRuntime.js or a foreign wrapper -> refusal, export untouched";
  if (!haveSrc) skip(ia4, "server/src not found");
  else {
    test(ia4, () => {
      const runtime = loadVendorRuntime(presentationOf({ current: [] }));
      const original = runtime.listActiveIncursions;
      const changed = core(runtime, { [RUNTIME_FILE]: `${readSource(RUNTIME_FILE)}\n// drift\n` });
      let r;
      assert.doesNotThrow(() => { r = changed.publish([lneEntry(1, 30001867)]); });
      assert.deepStrictEqual([r.ok, r.reason], [false, "INCURSION_UI_DRIFT"]);
      assert.strictEqual(runtime.listActiveIncursions, original);
      assert.strictEqual(changed.publish([lneEntry(1, 30001867)]).reason, "INCURSION_UI_DRIFT", "cached");

      const foreign = function otherModWrap() { return original.apply(this, arguments); };
      runtime.listActiveIncursions = foreign;
      const wrapped = core(runtime);
      assert.strictEqual(wrapped.publish([lneEntry(1, 30001867)]).reason, "INCURSION_UI_DRIFT");
      assert.strictEqual(runtime.listActiveIncursions, foreign);
      assert.strictEqual(wrapped.stats().installed, false);
    });
  }
};
