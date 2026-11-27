"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { installHandshakeHook, sha256, TAIL, TAIL_MARKER, DCB_KEY, MOON_KEY, HANDSHAKE_REL } =
  require("../../lib/adapter/handshakeHook");
const { resolveConfig } = require("../../config");

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const HANDSHAKE_FILE = path.join(ROOT, ...HANDSHAKE_REL);
const DCB_SIM = path.join(ROOT, "mods", "droneClassBalance", "simulation");
const MOD_DIR = path.join(ROOT, "mods", "shipWing");
const MOON_DIR = path.join(ROOT, "mods", "moonOreAnomalies");
const MOON_NAMES = path.join(MOON_DIR, "lib", "transientNames.js");
const DEFAULT_HASHES = resolveConfig({ modDir: MOD_DIR, env: {} }).config.clientWindowHandshakeHashes;

const FAKE_ROOT = path.join(path.sep, "srv");
const FAKE_FILE = path.join(FAKE_ROOT, ...HANDSHAKE_REL);
const FAKE_TEXT = "function buildTidiSignedFunc(clientId, options = {}) { return clientId; }\n"
  + "const tuple = [buildTidiSignedFunc(this.clientId, { accountRole: this.accountRole }), 0];\n";

const NO_CALL_TEXT = "function buildTidiSignedFunc(a) {}\n";
const DELIVERY = Object.freeze({ compose: (original) => original });

function logger() {
  const lines = [];
  return { lines, log: (m) => lines.push(m) };
}

function host(cache = {}) {
  const calls = [];
  const base = function baseCompile() {
    calls.push(Array.prototype.slice.call(arguments));
    return "compiled";
  };
  return { calls, base, moduleApi: { _cache: cache, prototype: { _compile: base } } };
}

function fakeDeps(extra = {}) {
  return { globalObj: {}, root: FAKE_ROOT, readFile: () => FAKE_TEXT, hashes: [sha256(FAKE_TEXT)],
    delivery: DELIVERY, logger: logger(), ...extra };
}

module.exports = ({ test, skip }) => {
  const haveTree = fs.existsSync(HANDSHAKE_FILE) && fs.existsSync(path.join(DCB_SIM, "familyRuntime.js"))
    && fs.existsSync(MOON_NAMES);
  if (!haveTree) {
    skip("HH1 composition", `no handshake.js, droneClassBalance or moonOreAnomalies under ${ROOT}`);
  } else {
    test("HH1 composition: real handshake.js, shipWing first, then the real Moon names hook and the real DCB "
      + "family hook -> both peers wrap the login call, our tail last and once, source parses", () => {
      const baseline = fs.readFileSync(HANDSHAKE_FILE, "utf8");
      const h = host();
      const globalObj = {};
      const log = logger();
      const ours = installHandshakeHook({ moduleApi: h.moduleApi, globalObj, root: ROOT,
        readFile: (f) => fs.readFileSync(f, "utf8"), hashes: DEFAULT_HASHES, delivery: DELIVERY, logger: log });
      assert.strictEqual(ours.ok, true, JSON.stringify(ours));
      assert.strictEqual(ours.state.status, "HOOKED");
      const Module = require("node:module");
      const names = require(MOON_NAMES);
      require(path.join(ROOT, "server", "src", "network", "protocolProfile.js"));
      const { attachMember } = require(path.join(DCB_SIM, "familyRuntime.js"));
      const { readBundle } = require(path.join(DCB_SIM, "delivery.js"));
      const saved = Module.prototype._compile;
      const quiet = console.log;
      let moon = null;
      let dcb = null;
      try {
        Module.prototype._compile = h.moduleApi.prototype._compile;
        console.log = () => {};
        moon = names.install(ROOT, MOON_DIR);
        assert.strictEqual(moon.active, true, moon.reason);
        const peers = { _cache: {}, prototype: { _compile: Module.prototype._compile } };
        dcb = attachMember(ROOT, { id: "droneclassbalance", bundle: readBundle(DCB_SIM),
          eligible: () => false, policy: () => null }, globalObj, peers);
        assert.strictEqual(dcb.active, true, JSON.stringify(dcb));
        assert.strictEqual(globalObj[DCB_KEY], dcb);
        assert.strictEqual(peers.prototype._compile.call({}, baseline, HANDSHAKE_FILE), "compiled");
      } finally {
        console.log = quiet;
        if (moon && typeof moon.restore === "function") moon.restore();
        Module.prototype._compile = saved;
        delete globalThis[MOON_KEY];
      }
      assert.strictEqual(dcb.transformed, true, "DCB transformed the source");
      assert.strictEqual(h.calls.length, 1);
      const content = h.calls[0][0];
      assert.ok(content.endsWith(TAIL), "our tail is last");
      assert.strictEqual(content.split(`const ${TAIL_MARKER} =`).length, 2, "our tail once");
      for (const owner of ["evejs.ourMods.privateFittingRuntime", "evejs.moonOreAnomalies.transientNames"]) {
        assert.strictEqual(content.split(`globalThis[Symbol.for("${owner}")]?.compose(`).length, 2, owner);
      }
      vm.compileFunction(content, ["exports", "require", "module", "__filename", "__dirname"]);
      assert.strictEqual(ours.state.status, "WRAPPED");
      assert.deepStrictEqual([ours.state.dcb, ours.state.moon], [true, true]);
      assert.deepStrictEqual(log.lines, [`SHIPWING_UI:WRAPPER_READY tail=${ours.state.tailBytes} dcb=1 moon=1`]);
      assert.strictEqual(Buffer.byteLength(content) - Buffer.byteLength(baseline) - Buffer.byteLength(TAIL),
        ours.state.tailBytes);
      h.moduleApi.prototype._compile.call({}, baseline, HANDSHAKE_FILE);
      assert.ok(!h.calls[1][0].includes(TAIL_MARKER));
    });
  }

  test("HH2 load order: DCB or moon symbol already on globalThis -> LOAD_ORDER, no hook, _compile unchanged", () => {
    for (const key of [DCB_KEY, MOON_KEY]) {
      const h = host();
      const r = installHandshakeHook({ ...fakeDeps({ globalObj: { [key]: {} } }), moduleApi: h.moduleApi });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, "LOAD_ORDER");
      assert.ok(r.line.startsWith("SHIPWING_UI:UNAVAILABLE:LOAD_ORDER"), r.line);
      assert.strictEqual(h.moduleApi.prototype._compile, h.base);
    }
  });

  test("HH3 refusals: unknown hash (hash in the line), handshake.js cached, unreadable, seam text missing, "
    + "no payload; a source that is not the baseline -> unchanged + CONFLICTING_SOURCE", () => {
    const cases = [
      [{ hashes: ["0".repeat(64)] }, {}, "UNKNOWN_HANDSHAKE"],
      [{}, { [FAKE_FILE.toUpperCase()]: {} }, "HANDSHAKE_ALREADY_LOADED"],
      [{ readFile: () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } }, {}, "HANDSHAKE_UNREADABLE"],
      [{ readFile: () => NO_CALL_TEXT, hashes: [sha256(NO_CALL_TEXT)] }, {}, "SEAM_CHANGED"],
      [{ delivery: null }, {}, "CLIENT_SOURCE"],
    ];
    for (const [extra, cache, reason] of cases) {
      const h = host(cache);
      const r = installHandshakeHook({ ...fakeDeps(extra), moduleApi: h.moduleApi });
      assert.strictEqual(r.reason, reason, JSON.stringify(r));
      assert.strictEqual(h.moduleApi.prototype._compile, h.base, reason);
    }
    const unknown = installHandshakeHook({ ...fakeDeps({ hashes: ["0".repeat(64)] }), moduleApi: host().moduleApi });
    assert.strictEqual(unknown.line, `SHIPWING_UI:UNAVAILABLE:UNKNOWN_HANDSHAKE hash=${sha256(FAKE_TEXT)}`);

    const h = host();
    const deps = fakeDeps();
    const r = installHandshakeHook({ ...deps, moduleApi: h.moduleApi });
    assert.strictEqual(r.ok, true);
    const changed = `// edited\n${FAKE_TEXT}`;
    h.moduleApi.prototype._compile.call({}, changed, FAKE_FILE);
    assert.strictEqual(h.calls[0][0], changed, "content unchanged");
    assert.strictEqual(r.state.status, "CONFLICT");
    assert.deepStrictEqual(deps.logger.lines, ["SHIPWING_UI:UNAVAILABLE:CONFLICTING_SOURCE"]);
  });

  test("HH4 the hook passes every argument of _compile and `this`; other files untouched", () => {
    const h = host();
    let seenThis = null;
    const previous = h.moduleApi.prototype._compile;
    h.moduleApi.prototype._compile = function spy() {
      seenThis = this;
      return previous.apply(this, arguments);
    };
    const r = installHandshakeHook({ ...fakeDeps(), moduleApi: h.moduleApi });
    const self = { id: "module" };
    assert.strictEqual(h.moduleApi.prototype._compile.call(self, FAKE_TEXT, FAKE_FILE, "commonjs"), "compiled");
    assert.strictEqual(seenThis, self);
    assert.deepStrictEqual(h.calls[0], [FAKE_TEXT + TAIL, FAKE_FILE, "commonjs"]);
    assert.strictEqual(r.state.status, "WRAPPED");
    h.moduleApi.prototype._compile.call(self, "other", path.join(FAKE_ROOT, "x.js"), "module", 4);
    assert.deepStrictEqual(h.calls[1], ["other", path.join(FAKE_ROOT, "x.js"), "module", 4]);
  });

  test("HH5 (261115.2) TAIL passes clientId and { accountRole } on to the previous login function", () => {
    const run = (delivery) => {
      const seen = [];
      const native = Buffer.from([0x74, 0, 0, 0, 0]);
      const g = { [Symbol.for("evejs.shipWing.clientDelivery.v1")]: delivery };
      const source = "\"use strict\";\nfunction buildTidiSignedFunc(clientId, options = {}) {"
        + " seen.push([clientId, options]); return native; }\n" + TAIL + "\nreturn buildTidiSignedFunc;\n";
      const login = vm.compileFunction(source, ["seen", "native", "globalThis"])(seen, native, g);
      return { seen, native, out: login(7, { accountRole: "1" }) };
    };
    const composed = Buffer.from([0x74, 1, 0, 0, 0, 0x31]);
    const a = run({ compose: (original) => (Buffer.isBuffer(original) ? composed : null) });
    assert.deepStrictEqual(a.seen, [[7, { accountRole: "1" }]]);
    assert.strictEqual(a.out, composed);
    const b = run(undefined);
    assert.deepStrictEqual(b.seen, [[7, { accountRole: "1" }]]);
    assert.strictEqual(b.out, b.native);
    const c = run({ compose: () => { throw new Error("x"); } });
    assert.strictEqual(c.out, c.native);
  });
};
