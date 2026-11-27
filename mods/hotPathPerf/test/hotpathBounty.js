"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const {
  createBountyPoolRead, fixedUpstream, FINGERPRINTS, STATE_FUNCTIONS, CHAR_FUNCTIONS, PROXY_FUNCTIONS,
} = require("../lib/bountyPoolRead");
const tree = require("./fixtures/bountyTree");

const MISSING = path.join(__dirname, "missing.json");

function stringify(value) {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

function cleanup(t) {
  for (const key of Object.keys(require.cache)) if (key.startsWith(t.root)) delete require.cache[key];
  fs.rmSync(t.root, { recursive: true, force: true });
}

function register(ctx) {
  const { test, config, loader, SERVER_SRC } = ctx;
  const files = {
    state: path.join(SERVER_SRC, "services", "bounty", "playerBountyState.js"),
    char: path.join(SERVER_SRC, "services", "character", "characterState.js"),
    proxy: path.join(SERVER_SRC, "services", "bounty", "bountyProxyService.js"),
  };
  const haveSrc = Object.values(files).every((f) => fs.existsSync(f));
  const texts = haveSrc ? { state: fs.readFileSync(files.state, "utf8"), char: fs.readFileSync(files.char, "utf8"),
    proxy: fs.readFileSync(files.proxy, "utf8") } : null;
  const sources = haveSrc ? { stateSource: texts.state, charSource: texts.char, proxySource: texts.proxy } : null;
  const legacySources = haveSrc ? { ...sources, proxySource: tree.legacyProxy(texts.proxy) } : null;
  const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
  const base = { ...config, ...quiet, prewarmLocations: false, schedulerMaxPending: 0, schedulerRequestTimeoutMs: 0 };

  function load(flagOn, opts = {}) {
    const t = tree.makeTree(opts.upstream ? { ...texts, upstream: true } : texts, opts.tamper || null);
    const previous = Module._load;
    const lines = [];
    try {
      if (opts.before) opts.before(t);
      const state = loader.createState({ ...base, bountyPoolRead: flagOn, bountyPoolReadParityCheck: opts.parity === true }, null,
        { log: (l) => lines.push(l) });
      loader.installHook(state);
      const Proxy = require(t.files.proxy);
      return { t, state, lines, proxy: new Proxy(), Proxy, fake: require(t.files.repo),
        stateMod: require(t.files.state), charMod: require(t.files.char) };
    } finally {
      Module._load = previous;
    }
  }

  function call(h, method, args) {
    return stringify(h.proxy.callMethod(method, args, null, null));
  }

  function unit(cfg = {}) {
    const h = load(false);
    const lines = [];
    const b = createBountyPoolRead({ config: cfg, log: (l) => lines.push(l) });
    assert.strictEqual(b.setPoolDeps(h.stateMod), true);
    assert.strictEqual(b.setCharDeps(h.charMod), true);
    assert.deepStrictEqual(b.checkFingerprint(legacySources), { ok: true });
    return { h, b, lines, getPool: b.wrapGetPool(h.stateMod.getPool), getChar: b.wrapGetCharacterRecord(h.charMod.getCharacterRecord) };
  }

  test("BP1 bountyPoolRead: parity ≥ 50 IDs (characters, corporations, alliances, unknown, out of range), 1 state read, 0 clones", () => {
    if (!haveSrc) return;
    assert.ok(tree.REQUEST_IDS.length >= 50, "fixture ≥ 50 IDs");
    const args = [[...tree.REQUEST_IDS]];
    const krArgs = [[...tree.REQUEST_IDS], [...tree.KILL_RIGHT_IDS]];
    const off = load(false);
    const on = load(true);
    try {
      const offBounties = call(off, "GetBounties", args);
      const idCount = JSON.parse(offBounties).items.length;
      assert.ok(idCount >= 49, `unikalne ID: ${idCount}`);
      assert.strictEqual(off.fake.counters.stateReads, idCount, "vendor: readState per ID");
      assert.strictEqual(off.fake.counters.clones, 2 * Object.keys(tree.CHARACTERS).length, "vendor: 2 record clones per character");
      for (const symbol of loader.BOUNTY_REQUIRED) assert.ok(on.state.patched.has(symbol), symbol);
      const onBounties = call(on, "GetBounties", args);
      assert.strictEqual(onBounties, offBounties, "GetBounties bit for bit");
      assert.deepStrictEqual([on.fake.counters.stateReads, on.fake.counters.clones], [1, 0], "1 state read, 0 clones");
      const positive = JSON.parse(onBounties).items.filter(([id]) => id > 0).length;
      assert.strictEqual(on.fake.counters.readShared, positive, "readShared once per ID");
      const kinds = JSON.parse(offBounties).items;
      assert.ok(kinds.some(([, kv]) => kv.entries.some(([k, v]) => k === "bounty" && v > 0)), "pools > 0 in the response");
      const snap = on.state.bounty.statsSnapshot();
      assert.deepStrictEqual([snap.handlers, snap.ids, snap.idsMax, snap.stateReads, snap.passthrough], [1, idCount, idCount, 1, 0]);
      assert.ok(snap.charMemoHits >= 20 && snap.charServed === positive + snap.charMemoHits, stringify(snap));
      const offKr = call(off, "GetBountiesAndKillRights", krArgs);
      const clonesBefore = on.fake.counters.clones;
      const onKr = call(on, "GetBountiesAndKillRights", krArgs);
      assert.strictEqual(onKr, offKr, "GetBountiesAndKillRights bit for bit");
      assert.strictEqual(on.fake.counters.stateReads, 2, "1 state read per handler");
      assert.strictEqual(on.fake.counters.clones - clonesBefore, 3, "clones only in kill rights (3 characters with a record)");
      assert.ok(JSON.parse(onKr)[1].items.every((kv) => kv.entries[2][1].endsWith("(kill right)")));
      const lines = on.state.bounty.drainStatsLines();
      assert.ok(/^stats bountyPoolRead state=ready handlers=2 ids=\d+ idsMax=\d+ stateReads=2 charServed=\d+ charMemoHits=\d+ passthrough=0 fallback=- parityChecks=0$/
        .test(lines[0]), lines[0]);
      assert.deepStrictEqual(on.state.bounty.drainStatsLines(), [], "window without handlers = no line");
      const p = load(true, { parity: true });
      try {
        assert.strictEqual(call(p, "GetBounties", args), offBounties);
        assert.deepStrictEqual([p.state.bounty.statsSnapshot().parityChecks, p.state.bounty.status().state], [idCount, "ready"]);
      } finally {
        cleanup(p.t);
      }
    } finally {
      cleanup(off.t);
      cleanup(on.t);
    }
  });

  test("BP2 bountyPoolRead: config, settings, compose, flag off = no wrappers and no pattern part; on = 7 points", () => {
    const cfg = require("../config");
    const def = cfg.loadConfig({ env: {}, settingsPath: MISSING });
    assert.deepStrictEqual([def.bountyPoolRead, def.bountyPoolReadParityCheck], [false, false]);
    const env = cfg.loadConfig({ env: { HOTPATH_BOUNTY_POOL_READ: "1", HOTPATH_BOUNTY_POOL_READ_PARITY: "on" }, settingsPath: MISSING });
    assert.deepStrictEqual([env.bountyPoolRead, env.bountyPoolReadParityCheck], [true, true]);
    const settings = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "settings.json"), "utf8"));
    assert.strictEqual(settings.bountyPoolRead, false);
    const compose = fs.readFileSync(path.join(__dirname, "..", "..", "..", "compose.yaml"), "utf8");
    assert.ok(compose.includes("HOTPATH_BOUNTY_POOL_READ: ${HOTPATH_BOUNTY_POOL_READ:-0}"));
    assert.ok(compose.includes("HOTPATH_BOUNTY_POOL_READ_PARITY: ${HOTPATH_BOUNTY_POOL_READ_PARITY:-0}"));
    assert.strictEqual(loader.targetOf("/app/server/src/services/bounty/playerBountyState.js"), "playerBountyState");
    assert.strictEqual(loader.targetOf("/app/server/src/services/character/characterState.js"), "characterState");
    const offState = loader.createState(base, null);
    assert.strictEqual(offState.bounty, null);
    assert.ok(!offState.requestPattern.test("./playerBountyState"));
    assert.ok(![...offState.expected].some((s) => s.includes("#bounty")));
    const onState = loader.createState({ ...base, bountyPoolRead: true }, null, { log: () => {} });
    for (const r of ["./playerBountyState", "../character/characterState", "/app/server/src/services/bounty/bountyProxyService.js"]) {
      assert.ok(onState.requestPattern.test(r), r);
    }
    if (!haveSrc) return;
    const off = load(false);
    const on = load(true);
    try {
      assert.strictEqual(off.charMod.getCharacterRecord.__hotPathPerfBounty, undefined);
      assert.strictEqual(off.stateMod.getPool.__hotPathPerfBounty, undefined);
      assert.strictEqual(off.Proxy.prototype.Handle_GetBounties.__hotPathPerfBounty, undefined);
      assert.strictEqual(off.Proxy.prototype.Handle_GetBountiesAndKillRights.__hotPathPerfBounty, undefined);
      assert.ok(on.charMod.getCharacterRecord.__hotPathPerfBounty && on.stateMod.getPool.__hotPathPerfBounty);
      assert.ok(on.Proxy.prototype.Handle_GetBounties.__hotPathPerfBounty && on.Proxy.prototype.Handle_GetBountiesAndKillRights.__hotPathPerfBounty);
      assert.strictEqual(on.state.bounty.status().state, "ready");
      on.state.gameSeen = true;
      assert.strictEqual(loader.checkBountyDrift(on.state), false);
      assert.ok(/^probe: passed \(7 /.test(loader.probeMessage(on.state)), loader.probeMessage(on.state));
    } finally {
      cleanup(off.t);
      cleanup(on.t);
    }
  });

  test("BP3 bountyPoolRead: scope boundaries — outside the handler/kill rights a clone, nested = original, caller state, exception", () => {
    if (!haveSrc) return;
    const on = load(true);
    try {
      const frozenBefore = on.charMod.readSharedCharacterRecord(90000001);
      const outside = on.charMod.getCharacterRecord(90000001);
      assert.ok(!Object.isFrozen(outside) && outside !== frozenBefore, "outside the handler = clone");
      outside.name = "mutated";
      assert.strictEqual(on.charMod.readSharedCharacterRecord(90000001).name, "Pilot 1", "frozen record untouched");
      on.fake.counters.nestedFrom = 90000009;
      on.fake.counters.nestedTo = 90000010;
      call(on, "GetBounties", [[90000009]]);
      const nested = on.fake.counters.nestedResult;
      assert.ok(nested && !Object.isFrozen(nested) && nested.name === "Pilot 10", "nested = original");
    } finally {
      cleanup(on.t);
    }
    const u = unit();
    try {
      const own = { pools: { 90000001: { targetID: 90000001, bounty: 42 } } };
      const scoped = u.b.wrapScope(function Handle_GetBounties() { return [u.getPool(own, 90000001), u.getPool(null, 90000001)]; });
      const [fromOwn, fromScope] = scoped.call({});
      assert.deepStrictEqual([fromOwn.bounty, fromScope.bounty], [42, 5000000]);
      assert.deepStrictEqual(u.b.statsSnapshot().fallback, { stateArg: 1 });
      const boom = u.b.wrapScope(function Handle_GetBounties() { u.getPool(null, 90000001); throw new Error("boom"); });
      assert.throws(() => boom.call({}), /boom/);
      const reads = u.h.fake.counters.stateReads;
      const clones = u.h.fake.counters.clones;
      assert.ok(!Object.isFrozen(u.getChar(90000001)));
      u.getPool(null, 90000001);
      assert.deepStrictEqual([u.h.fake.counters.stateReads - reads, u.h.fake.counters.clones - clones > 0], [1, true]);
      assert.strictEqual(u.b.statsSnapshot().handlers, 2);
    } finally {
      cleanup(u.h.t);
    }
  });

  test("BP4 bountyPoolRead: drift (every fingerprint function), late_wrap (cache and sweep), order, parity, error", () => {
    if (!haveSrc) return;
    const args = [[...tree.REQUEST_IDS]];
    const vendor = load(false);
    const expected = call(vendor, "GetBounties", args);
    cleanup(vendor.t);
    for (const name of [...STATE_FUNCTIONS, ...CHAR_FUNCTIONS, ...PROXY_FUNCTIONS]) {
      const h = load(true, { tamper: name });
      try {
        assert.strictEqual(h.state.bounty.status().state, "disabled:drift", name);
        assert.ok(h.lines.includes(`WARN bountyPoolRead disabled: drift (${name})`), h.lines.join("|"));
        assert.strictEqual(h.charMod.getCharacterRecord.__hotPathPerfBounty, undefined, name);
        assert.strictEqual(call(h, "GetBounties", args), expected, name);
        h.state.gameSeen = true;
        assert.ok(loader.probeMessage(h.state).endsWith("; bountyPoolRead disabled: drift"), loader.probeMessage(h.state));
      } finally {
        cleanup(h.t);
      }
    }
    const late = load(true, { before: (t) => { require(t.files.state); } });
    try {
      assert.strictEqual(late.state.bounty.status().state, "disabled:late_wrap");
      assert.ok(late.lines.some((l) => l.startsWith("WARN bountyPoolRead disabled: late_wrap (playerBountyState loaded")), late.lines.join("|"));
      assert.strictEqual(call(late, "GetBounties", args), expected);
      assert.strictEqual(late.fake.counters.stateReads, JSON.parse(expected).items.length, "disabled = vendor");
    } finally {
      cleanup(late.t);
    }
    const raw = load(false);
    try {
      const state = loader.createState({ ...base, bountyPoolRead: true }, null, { log: () => {} });
      loader.sweepModuleCache(state, { [raw.t.files.char]: { loaded: true, exports: raw.charMod } });
      assert.strictEqual(state.bounty.status().state, "disabled:late_wrap");
      const st2 = loader.createState({ ...base, bountyPoolRead: true }, null, { log: () => {} });
      const foreign = { getPool: function foreignGetPool() { return null; }, _testing: raw.stateMod._testing };
      loader.patchTarget("playerBountyState", foreign, st2, raw.t.files.state);
      assert.strictEqual(st2.bounty.status().state, "disabled:order");
      assert.strictEqual(foreign.getPool.name, "foreignGetPool");
    } finally {
      cleanup(raw.t);
    }
    const u = unit({ bountyPoolReadParityCheck: true });
    try {
      const original = u.h.stateMod.getPool;
      const lying = function getPool(state, id) {
        const result = original(state, id);
        return state ? { ...result, bounty: result.bounty + 1 } : result;
      };
      const wrapped = u.b.wrapGetPool(lying);
      const scoped = u.b.wrapScope(function Handle_GetBounties() { return wrapped(null, 90000001); });
      assert.strictEqual(scoped.call({}).bounty, 5000000);
      assert.strictEqual(u.b.status().state, "disabled:parity");
      assert.ok(u.lines.includes("WARN bountyPoolRead disabled: parity (targetID=90000001)"), u.lines.join("|"));
    } finally {
      cleanup(u.h.t);
    }
    const e = unit();
    try {
      const b = createBountyPoolRead({ config: {}, log: () => {} });
      b.setPoolDeps({ _testing: { readState() { throw new Error("db gone"); } } });
      b.setCharDeps(e.h.charMod);
      b.checkFingerprint(legacySources);
      const wrapped = b.wrapGetPool(e.h.stateMod.getPool);
      const scoped = b.wrapScope(function Handle_GetBounties() { return wrapped(null, 98000001); });
      const got = scoped.call({});
      assert.deepStrictEqual([got.targetKind, got.bounty, b.status().state], ["corporation", 25000000, "disabled:error"]);
      assert.deepStrictEqual(b.statsSnapshot().fallback, { error: 1 });
    } finally {
      cleanup(e.h.t);
    }
  });

  test("BP5 vendor facts 261115.2: getPools = obsolete, fingerprint 261108.1 = reversed hunk, getCharacterRecord destructuring, class and callMethod", () => {
    if (!haveSrc) return;
    assert.deepStrictEqual(createBountyPoolRead({ config: {}, log: () => {} }).checkFingerprint(sources),
      { ok: false, reason: "drift", detail: "buildBountyEntry" });
    assert.deepStrictEqual(createBountyPoolRead({ config: {}, log: () => {} }).checkFingerprint(legacySources), { ok: true },
      "reversed hunk = 261108.1 text");
    assert.strictEqual(fixedUpstream(sources), true);
    assert.strictEqual(fixedUpstream(legacySources), false);
    assert.ok(texts.state.replace(/\r\n/g, "\n").includes("\n  getPools,\n"), "getPools export");
    assert.strictEqual(Object.keys(FINGERPRINTS.state).length + Object.keys(FINGERPRINTS.char).length + Object.keys(FINGERPRINTS.proxy).length, 10);
    const st = texts.state.replace(/\r\n/g, "\n");
    assert.ok(/\nconst \{\n  getCharacterRecord,\n\} = require\(path\.join\(__dirname, "\.\.\/character\/characterState"\)\);\n/.test(st),
      "playerBountyState destructures getCharacterRecord");
    assert.ok(/\n  _testing: \{\n[^}]*\n    readState,\n/.test(st), "_testing.readState");
    assert.ok(/\nmodule\.exports = \{\n[\s\S]*?\n  getPool,\n/.test(st));
    const hits = [];
    for (const file of ctx.listJs(SERVER_SRC)) {
      const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      if (!text.includes("getPool") || !text.includes("playerBountyState") || file.endsWith("playerBountyState.js")) continue;
      text.split("\n").forEach((line) => {
        if (/\bgetPool\b/.test(line)) {
          hits.push(`${path.relative(SERVER_SRC, file).replace(/\\/g, "/")}:${line.trim()}`);
        }
      });
    }
    assert.deepStrictEqual(hits, []);
    const px = texts.proxy.replace(/\r\n/g, "\n");
    assert.ok(px.includes("\nmodule.exports = BountyProxyService;\n"));
    assert.ok(/callMethod\(method, args, session, kwargs\) \{[\s\S]*?return this\[handlerName\]\(args, session, kwargs\);/.test(px));
    assert.ok(/\n  Handle_GetBounties\(args, session\) \{\n/.test(px) && /\n  Handle_GetBountiesAndKillRights\(args, session\) \{\n/.test(px));
    const ch = texts.char.replace(/\r\n/g, "\n");
    assert.ok(/\nfunction getCharacterRecord\(charId, options = \{\}\) \{\n  const record = readSharedCharacterRecord\(charId, options\);\n  return record \? cloneValue\(record\) : null;\n\}\n/.test(ch));
    assert.ok(/\nmodule\.exports = \{\n[\s\S]*?\n  getCharacterRecord,\n[\s\S]*?\n  readSharedCharacterRecord,\n/.test(ch));
  });

  test("BP6 bountyPoolRead 261115.2 = obsolete: flag on = no wrappers and no DRIFT, WARN once, response = vendor (1 state read)", () => {
    if (!haveSrc) return;
    const args = [[...tree.REQUEST_IDS]];
    const off = load(false, { upstream: true });
    const on = load(true, { upstream: true });
    try {
      const expected = call(off, "GetBounties", args);
      assert.strictEqual(off.fake.counters.stateReads, 1, "vendor 261115.2 reads the state once itself");
      assert.strictEqual(call(on, "GetBounties", args), expected);
      assert.strictEqual(on.state.bounty.status().state, "disabled:obsolete");
      assert.strictEqual(on.Proxy.prototype.Handle_GetBounties.__hotPathPerfBounty, undefined);
      assert.strictEqual(on.stateMod.getPool.__hotPathPerfBounty, undefined);
      assert.strictEqual(on.charMod.getCharacterRecord.__hotPathPerfBounty, undefined);
      assert.deepStrictEqual(on.lines.filter((l) => l.includes("bountyPoolRead")),
        ["WARN bountyPoolRead disabled: obsolete (EveJS reads it itself: playerBountyState.getPools)"]);
      on.state.gameSeen = true;
      const probe = loader.probeMessage(on.state);
      assert.ok(!/DRIFT/.test(probe) && probe.endsWith("; bountyPoolRead disabled: obsolete"), probe);
    } finally {
      cleanup(off.t);
      cleanup(on.t);
    }
  });
}

module.exports = { register };
