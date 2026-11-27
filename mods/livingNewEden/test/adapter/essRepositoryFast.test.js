"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const NodeModule = require("node:module");
const vm = require("node:vm");
const { isDeepStrictEqual } = require("node:util");

const fast = require("../../lib/adapter/essRepositoryFast");
const loader = require("../../loader");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const TABLE = "dynamicResourceRuntime";
const GROUPS = ["systems", "funding", "settlements", "unlocks", "losses"];
const SEP = "\u001f";
const SYS_A = "30000142";
const SYS_B = "30002187";
const SYS_NEW = "30045342";
const OK = Object.freeze({ success: true, errorMsg: null });

function findSrcDir() {
  const found = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
  return found.ok ? found.srcDir : null;
}

function explode(root) {
  const rows = new Map();
  for (const key of Object.keys(root || {})) {
    const value = root[key];
    if (GROUPS.includes(key) && value && typeof value === "object" && !Array.isArray(value)) {
      rows.set(key, "{}");
      for (const entityKey of Object.keys(value)) {
        const json = JSON.stringify(value[entityKey]);
        if (json !== undefined) rows.set(`${key}${SEP}${entityKey}`, json);
      }
    } else {
      const json = JSON.stringify(value);
      if (json !== undefined) rows.set(key, json);
    }
  }
  return rows;
}

function assemble(rows) {
  const out = {};
  for (const [key, json] of rows) {
    const at = key.indexOf(SEP);
    if (at >= 0) {
      const group = key.slice(0, at);
      if (!out[group] || typeof out[group] !== "object") out[group] = {};
      out[group][key.slice(at + 1)] = JSON.parse(json);
    } else if (GROUPS.includes(key)) {
      if (!out[key]) out[key] = {};
    } else {
      out[key] = JSON.parse(json);
    }
  }
  return out;
}

function fakeStore(initial) {
  const s = { cache: { [TABLE]: initial }, writes: [], disk: explode(initial), dirty: false, fullDirty: false,
    dirtyRows: new Set(), failFlush: false, onWrite: null };
  const markRoot = (paths) => {
    if (!Array.isArray(paths) || paths.length === 0) {
      s.fullDirty = true;
      return;
    }
    for (const p of paths) {
      const segs = typeof p === "string" && p.startsWith("/") ? p.split("/").filter(Boolean) : [];
      if (segs.length === 0 || (GROUPS.includes(segs[0]) && segs.length === 1)) {
        s.fullDirty = true;
        return;
      }
      if (GROUPS.includes(segs[0])) {
        s.dirtyRows.add(`${segs[0]}${SEP}${segs[1]}`);
        s.dirtyRows.add(segs[0]);
      } else {
        s.dirtyRows.add(segs[0]);
      }
    }
  };
  s.ensureTable = () => true;
  s.read = (table, _p) => ({ success: true, errorMsg: null, data: s.cache[table] });
  s.write = function write(table, _p, data, options = {}) {
    s.writes.push({ data, options: arguments[3] });
    const old = s.cache[table];
    const same = old === data;
    const hint = Array.isArray(options.knownChangedPaths) && options.knownChangedPaths.length > 0
      && options.knownChangedPaths.every((p) => typeof p === "string" && p.startsWith("/")
        && p.split("/").some(Boolean));
    const unchanged = !same && !hint && options.force !== true && isDeepStrictEqual(old, data);
    if (unchanged) return OK;
    if (!same) s.cache[table] = data;
    if (s.onWrite) s.onWrite(old, data, options);
    markRoot(options.knownChangedPaths);
    s.dirty = true;
    return OK;
  };
  s.flushTableSync = () => {
    if (s.failFlush) throw new Error("FLUSH_FAILED");
    if (!s.dirty) return OK;
    const rows = explode(s.cache[TABLE]);
    if (s.fullDirty) {
      s.disk = rows;
    } else {
      for (const key of s.dirtyRows) {
        if (rows.has(key)) s.disk.set(key, rows.get(key));
        else s.disk.delete(key);
      }
    }
    s.dirty = false;
    s.fullDirty = false;
    s.dirtyRows.clear();
    return OK;
  };
  s.readPersisted = () => ({ success: true, errorMsg: null, data: assemble(s.disk) });
  return s;
}

function vanillaRepository(repository) {
  const TABLE_NAME = "dynamicResourceRuntime";
  function check(result) {
    if (!result?.success) throw new Error(result?.errorMsg || "ESS_STORE_FAILED");
    return result.data;
  }
  function read() {
    repository.ensureTable(TABLE_NAME);
    return { version: 1, systems: {}, funding: {}, settlements: {}, unlocks: {}, losses: {}, ...structuredClone(check(repository.read(TABLE_NAME, "/")) || {}) };
  }
  function write(next) {
    const previous = read();
    check(repository.write(TABLE_NAME, "/", next));
    let flush;
    try {
      flush = repository.flushTableSync(TABLE_NAME);
      check(flush);
    } catch (error) {
      const restored = repository.write(TABLE_NAME, "/", previous, { force: true });
      if (restored?.success && flush?.errorMsg === "FLUSH_ERROR") {
        error.code = "DYNAMIC_RESOURCE_FLUSH_ERROR";
      }
      throw error;
    }
  }
  function mutate(callback) {
    const next = read();
    const result = callback(next);
    write(next);
    return result;
  }
  return { TABLE_NAME, read, write, mutate, check };
}

function initialState() {
  return {
    version: 1,
    systems: {
      [SYS_A]: { solarSystemID: Number(SYS_A), essID: 9001, mainValue: 0, reserveValue: 0, contributors: {},
        autopayAtMs: null, reserveLinkedCharacterIDs: [], dbs: { active: true, periods: { 0: { paidCents: 0 } } } },
      [SYS_B]: { solarSystemID: Number(SYS_B), essID: 9002, mainValue: 12.5, contributors: { 90000002: 1250 } },
    },
    funding: { "receipt:1": { fingerprint: "a", grossCents: 100 } },
    settlements: { [`ess:${SYS_B}:autopay:1`]: { id: `ess:${SYS_B}:autopay:1`, systemID: Number(SYS_B),
      state: "completed", payments: [], amount: 0 } },
    losses: { 17: { systemID: Number(SYS_A), cents: 5 } },
  };
}

function fastRepository(store, extra = {}) {
  const vanilla = vanillaRepository(store);
  const core = fast.createEssRepositoryFast({ originals: vanilla, tableRepo: store, readPersisted: store.readPersisted,
    fast: true, parityEvery: 0, ...extra });
  return { core, repo: { ...vanilla, ...core.api } };
}

const SCRIPT = [
  ["fund", (r) => r.mutate((root) => {
    if (root.funding["receipt:2"]) return "dup";
    const bank = root.systems[SYS_A];
    bank.mainValue += 5;
    bank.contributors ||= {};
    bank.contributors[90000001] = (bank.contributors[90000001] || 0) + 500;
    bank.dbs.periods[0].paidCents += 500;
    root.funding["receipt:2"] = { fingerprint: "b", grossCents: 500 };
    return "ok";
  })],
  ["fund again", (r) => r.mutate((root) => (root.funding["receipt:2"] ? "dup" : "ok"))],
  ["prepareMain", (r) => r.mutate((root) => {
    const bank = root.systems[SYS_A];
    const id = `ess:${SYS_A}:autopay:${bank.autopayAtMs}`;
    if (root.settlements[id]) return id;
    root.settlements[id] = { id, systemID: Number(SYS_A), kind: "autopay", state: "prepared", amount: 500,
      payments: Object.entries(bank.contributors).map(([c, v]) => ({ characterID: Number(c), cents: v })) };
    bank.mainValue = 0;
    bank.contributors = {};
    bank.autopayAtMs = null;
    return id;
  })],
  ["deliver", (r) => {
    const ids = [];
    for (const op of Object.values(r.read().settlements)) if (op.state !== "completed") ids.push(op.id);
    for (const id of ids) r.mutate((root) => { root.settlements[id].state = "completed"; });
    return ids;
  }],
  ["saveSystemState new", (r) => r.mutate((root) => {
    root.systems[SYS_NEW] = { solarSystemID: Number(SYS_NEW), essID: 9003, mainValue: 0 };
  })],
  ["delete and re-add", (r) => r.mutate((root) => {
    const bank = root.systems[SYS_A];
    delete root.systems[SYS_A];
    root.systems[SYS_A] = { ...bank, mainValue: 7 };
  })],
  ["text before integer keys", (r) => r.mutate((root) => {
    root.funding["char:90000001:x"] = { fingerprint: "c", grossCents: 1 };
    root.settlements[42] = { id: "42", state: "prepared" };
    root.settlements[7] = { id: "7", state: "prepared" };
    return Object.keys(root.settlements);
  })],
  ["clearSystemState", (r) => r.mutate((root) => { delete root.systems[SYS_B]; })],
  ["root key added", (r) => r.mutate((root) => {
    root.meta = { a: 1 };
    root.systems[SYS_A].mainValue += 1;
  })],
  ["root key removed", (r) => r.mutate((root) => {
    delete root.meta;
    root.systems[SYS_A].mainValue += 1;
  })],
  ["delete with another change", (r) => r.mutate((root) => {
    delete root.funding["receipt:1"];
    root.systems[SYS_A].mainValue += 1;
  })],
  ["replace group", (r) => r.mutate((root) => { root.losses = { ...root.losses, 99: { systemID: 1, cents: 2 } }; })],
  ["missing unlocks", (r) => r.mutate((root) => {
    root.unlocks["ess:key:1"] = { id: "ess:key:1", state: "prepared", systemID: Number(SYS_A) };
    root.systems[SYS_A].reserveWindowID = "ess:key:1";
  })],
  ["settleUnlock refused", (r) => {
    r.mutate((root) => { Object.assign(root.unlocks["ess:key:1"], { state: "refused", errorMsg: undefined }); });
    return r.read().unlocks["ess:key:1"];
  }],
  ["recordLoss", (r) => {
    if (r.read().losses[18]) return false;
    r.mutate((root) => { if (!root.losses[18]) root.losses[18] = { systemID: Number(SYS_A), cents: 3 }; });
    return true;
  }],
  ["callback throws", (r) => {
    try {
      r.mutate((root) => {
        root.systems[SYS_A].mainValue = 999;
        throw new Error("ESS_FUNDING_RECEIPT_CONFLICT");
      });
    } catch (err) {
      return err.message;
    }
    return "no throw";
  }],
  ["nested mutate", (r) => r.mutate((root) => {
    root.funding.n1 = { a: 1 };
    r.mutate((inner) => { inner.funding.n2 = { b: 2 }; });
    return Object.keys(root.funding);
  })],
  ["write(read())", (r) => {
    const root = r.read();
    root.systems[SYS_A].mainValue = 11;
    r.write(root);
    return "written";
  }],
  ["views", (r) => {
    const root = r.read();
    return [JSON.stringify(root), SYS_A in root.systems, "nope" in root.systems, Object.keys(root.settlements),
      Object.entries(root.systems).map(([k, v]) => `${k}:${v.mainValue}`), { ...root.funding }];
  }],
  ["resetForTests write", (r) => r.write({ version: 1, systems: {}, funding: {}, settlements: {} })],
  ["after reset", (r) => r.mutate((root) => {
    root.systems[SYS_A] = { solarSystemID: Number(SYS_A), mainValue: 1 };
    root.losses[1] = { cents: 1 };
  })],
];

function runScript(repo, store, afterEach) {
  const results = [];
  for (const [name, op] of SCRIPT) {
    results.push([name, op(repo)]);
    if (afterEach) afterEach(name, store);
  }
  return results;
}

function covered(paths, rowKey) {
  for (const p of paths) {
    const segs = p.split("/").filter(Boolean);
    if (GROUPS.includes(segs[0]) && segs.length === 1) {
      if (rowKey === segs[0] || rowKey.startsWith(`${segs[0]}${SEP}`)) return true;
    } else if (GROUPS.includes(segs[0])) {
      if (rowKey === `${segs[0]}${SEP}${segs[1]}` || rowKey === segs[0]) return true;
    } else if (rowKey === segs[0]) {
      return true;
    }
  }
  return false;
}

function changedRows(oldRoot, newRoot) {
  const a = explode(oldRoot);
  const b = explode(newRoot);
  const out = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) if (a.get(key) !== b.get(key)) out.push(key);
  return out;
}

const silent = { log: () => {}, logError: () => {}, debug: () => {} };

module.exports = ({ test, skip }) => {
  test("T1 essRepositoryFast equivalence: caller patterns on vanilla and fast -> equal caches and key order, equal "
    + "results; isDeepStrictEqual skips shared branches (R5)", () => {
    const vStore = fakeStore(initialState());
    const fStore = fakeStore(initialState());
    const vanilla = vanillaRepository(vStore);
    const { repo, core } = fastRepository(fStore);
    const diffs = [];
    const vResults = runScript(vanilla, vStore);
    const fResults = [];
    for (const [name, op] of SCRIPT) {
      fResults.push([name, op(repo)]);
    }
    if (JSON.stringify(vStore.cache[TABLE]) !== JSON.stringify(fStore.cache[TABLE])) diffs.push("final cache");
    assert.deepStrictEqual(fResults, vResults);
    assert.deepStrictEqual(fStore.cache[TABLE], vStore.cache[TABLE]);
    assert.deepStrictEqual(diffs, [], "key order at every level (JSON text)");
    assert.strictEqual(core.state(), "on");
    const v2 = fakeStore(initialState());
    const f2 = fakeStore(initialState());
    const vr = vanillaRepository(v2);
    const fr = fastRepository(f2).repo;
    const steps = [];
    for (const [name, op] of SCRIPT) {
      op(vr);
      op(fr);
      if (JSON.stringify(v2.cache[TABLE]) !== JSON.stringify(f2.cache[TABLE])) steps.push(name);
    }
    assert.deepStrictEqual(steps, []);
    let getterCalls = 0;
    const shared = {};
    Object.defineProperty(shared, "x", { enumerable: true, get() { getterCalls += 1; return 1; } });
    assert.strictEqual(isDeepStrictEqual({ a: shared, b: 1 }, { a: shared, b: 1 }), true);
    assert.strictEqual(getterCalls, 0, "shared branch not walked");
  });

  test("T2 essRepositoryFast hint complete: changed rows ⊆ knownChangedPaths, SQLite rows = cache after every op; "
    + "stale and badKey without a hint; parity on / parity failure repairs", () => {
    const store = fakeStore(initialState());
    const { repo, core } = fastRepository(store, { parityEvery: 1 });
    const problems = [];
    let hinted = 0;
    let unhinted = 0;
    store.onWrite = (oldRoot, newRoot, options) => {
      const paths = options && options.knownChangedPaths;
      if (!paths) {
        unhinted += 1;
        return;
      }
      hinted += 1;
      for (const row of changedRows(oldRoot, newRoot)) if (!covered(paths, row)) problems.push(row);
    };
    const lost = [];
    runScript(repo, store, (name, s) => {
      const want = explode(s.cache[TABLE]);
      if (JSON.stringify([...want].sort()) !== JSON.stringify([...s.disk].sort())) lost.push(name);
    });
    assert.deepStrictEqual(problems, [], "a changed row outside the hint");
    assert.deepStrictEqual(lost, [], "SQLite rows differ from the cache (data lost after a restart)");
    assert.ok(hinted >= 10, `partial commits seen (${hinted})`);
    assert.ok(unhinted >= 2, `full commits seen (${unhinted})`);
    const st = core.stats();
    assert.strictEqual(core.state(), "on", "parity never failed");
    assert.ok(st.parity.checks > 10 && st.parity.fails === 0, JSON.stringify(st.parity));
    assert.ok(st.commits.stale >= 1, "nested mutate = stale");

    const s2 = fakeStore(initialState());
    const f2 = fastRepository(s2).repo;
    const hints = [];
    s2.onWrite = (_o, _n, options) => hints.push(options && options.knownChangedPaths ? "hint" : "none");
    f2.mutate((root) => { root.funding["a/b"] = { x: 1 }; });
    f2.mutate((root) => {
      root.funding.n1 = 1;
      f2.mutate((inner) => { inner.funding.n2 = 2; });
    });
    assert.deepStrictEqual(hints, ["none", "hint", "none"], "badKey none, inner hint, outer stale none");
    assert.deepStrictEqual(explode(s2.cache[TABLE]), s2.disk);

    const s3 = fakeStore({ ...initialState(), unlocks: {} });
    const lines = [];
    const f3 = fastRepository(s3, { parityEvery: 1, log: (l) => lines.push(l) });
    s3.disk.delete(`funding${SEP}receipt:1`);
    f3.repo.mutate((root) => { root.systems[SYS_A].mainValue = 3; });
    assert.strictEqual(f3.core.state(), "disabled:parity");
    assert.deepStrictEqual(explode(s3.cache[TABLE]), s3.disk, "repaired");
    assert.ok(lines.some((l) => l.includes("disabled: parity")), lines.join("\n"));
    assert.doesNotThrow(() => structuredClone(f3.repo.read()), "vendor read (plain objects) after the disable");
  });

  test("T2b essRepositoryFast parity repair through flushRepair: a promise with success:false or a rejection -> "
    + "WARN, no unhandled rejection", async () => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const run = async (repair) => {
        const s = fakeStore({ ...initialState(), unlocks: {} });
        const lines = [];
        const tables = [];
        const f = fastRepository(s, { parityEvery: 1, log: (l) => lines.push(l), flushRepair: (table) => {
          tables.push(table);
          return repair();
        } });
        s.disk.delete(`funding${SEP}receipt:1`);
        f.repo.mutate((root) => { root.systems[SYS_A].mainValue = 3; });
        await new Promise((r) => setImmediate(r));
        return [f.core.state(), tables, lines.filter((l) => l.includes("parity repair flush failed"))];
      };
      assert.deepStrictEqual(await run(async () => ({ success: true })), ["disabled:parity", [TABLE], []]);
      assert.deepStrictEqual(await run(async () => ({ success: false, errorMsg: "FLUSH_ERROR" })),
        ["disabled:parity", [TABLE], ["WARN essRepositoryFast parity repair flush failed (FLUSH_ERROR)"]]);
      assert.deepStrictEqual(await run(() => Promise.reject(new Error("worker gone"))),
        ["disabled:parity", [TABLE], ["WARN essRepositoryFast parity repair flush failed (worker gone)"]]);
      await new Promise((r) => setImmediate(r));
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  test("T3 essRepositoryFast snapshot: old state after a mutate, changes never reach the cache, generation "
    + "unchanged, one entity materialized", () => {
    const store = fakeStore(initialState());
    const { repo, core } = fastRepository(store);
    const generation = store.cache[TABLE];
    const before = fast.canonicalJson(generation);
    const snap = repo.read();
    repo.mutate((root) => { root.systems[SYS_A].mainValue = 42; });
    assert.notStrictEqual(store.cache[TABLE], generation, "a new generation");
    assert.strictEqual(snap.systems[SYS_A].mainValue, 0, "the snapshot keeps the state of its read()");
    snap.systems[SYS_A].mainValue = -1;
    Object.getOwnPropertyDescriptor(repo.read().systems, SYS_B).value.mainValue = -2;
    snap.funding.k = { x: 1 };
    delete snap.systems[SYS_B];
    assert.strictEqual(store.cache[TABLE].systems[SYS_A].mainValue, 42);
    assert.ok(!("k" in store.cache[TABLE].funding));
    assert.ok(SYS_B in store.cache[TABLE].systems);
    assert.strictEqual(store.cache[TABLE].systems[SYS_B].mainValue, 12.5, "a descriptor value is a clone too");
    assert.strictEqual(fast.canonicalJson(generation), before, "the previous generation is untouched");
    assert.strictEqual(store.cache[TABLE].funding, generation.funding, "untouched group shared");
    assert.strictEqual(store.cache[TABLE].systems[SYS_B], generation.systems[SYS_B], "untouched entity shared");

    core.resetWindow();
    const one = repo.read();
    assert.strictEqual(one.systems[SYS_A].mainValue, 42);
    assert.strictEqual(one.systems[SYS_A].mainValue, 42);
    const m = core.stats().materialized;
    assert.deepStrictEqual([m.systems, m.funding, m.settlements], [1, 0, 0]);
    assert.strictEqual(one.version, 1);
  });

  test("T4 essRepositoryFast rollback, flags off, stats mode: flush throw -> previous generation with force:true; "
    + "off -> no wrap; stats -> vendor result and throw unchanged, counters; handleJob counted", () => {
    const store = fakeStore(initialState());
    const { repo } = fastRepository(store);
    const generation = store.cache[TABLE];
    store.failFlush = true;
    assert.throws(() => repo.mutate((root) => { root.systems[SYS_A].mainValue = 5; }), /FLUSH_FAILED/);
    assert.strictEqual(store.cache[TABLE].systems, generation.systems, "the previous generation is the cache again");
    assert.strictEqual(store.cache[TABLE].systems[SYS_A].mainValue, 0);
    assert.deepStrictEqual(store.writes[store.writes.length - 1].options, { force: true });
    const vStore = fakeStore(initialState());
    vStore.failFlush = true;
    assert.throws(() => vanillaRepository(vStore).mutate((root) => { root.systems[SYS_A].mainValue = 5; }),
      /FLUSH_FAILED/);
    assert.deepStrictEqual(vStore.cache[TABLE], store.cache[TABLE]);
    const flushError = () => ({ success: false, errorMsg: "FLUSH_ERROR", flushed: false });
    const codeOf = (target) => {
      try {
        target.mutate((root) => { root.systems[SYS_A].mainValue = 6; });
      } catch (err) {
        return [err.message, err.code];
      }
      return null;
    };
    const fStore = fakeStore(initialState());
    fStore.flushTableSync = flushError;
    const vfStore = fakeStore(initialState());
    vfStore.flushTableSync = flushError;
    const retryable = ["FLUSH_ERROR", "DYNAMIC_RESOURCE_FLUSH_ERROR"];
    assert.deepStrictEqual(codeOf(fastRepository(fStore).repo), retryable);
    assert.deepStrictEqual(codeOf(vanillaRepository(vfStore)), retryable);
    assert.strictEqual(fStore.cache[TABLE].systems[SYS_A].mainValue, 0);

    const ex = vanillaRepository(fakeStore(initialState()));
    const originalRead = ex.read;
    assert.deepStrictEqual(fast.install(ex, { config: { fast: false, stats: false } }), { ok: false, reason: "disabled" });
    assert.strictEqual(ex.read, originalRead);

    const sentinel = { sentinel: true };
    const boom = new Error("ESS_STORE_FAILED");
    const statsExports = { TABLE_NAME: TABLE, read: () => sentinel, write: () => undefined,
      mutate: () => { throw boom; }, check: (r) => r.data };
    const out = fast.install(statsExports, { config: { fast: false, stats: true, parityEvery: 0 } });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.core.state(), "stats");
    assert.strictEqual(statsExports.read(), sentinel);
    assert.throws(() => statsExports.mutate(() => {}), (err) => err === boom);
    const st = out.core.stats();
    assert.deepStrictEqual([st.read.calls, st.mutate.calls, st.vanillaCloneEstimate], [1, 1, 3]);
    assert.strictEqual(fast.install(statsExports, { config: { stats: true } }).alreadyInstalled, true);

    const promise = Promise.resolve("done");
    const settlement = { handleJob: () => promise };
    assert.deepStrictEqual(fast.wrapHandleJob(settlement, out.core), { ok: true });
    assert.strictEqual(settlement.handleJob({ payload: { kind: "recover" } }), promise);
    assert.deepStrictEqual(fast.wrapHandleJob(settlement, out.core), { ok: false, reason: "already_wrapped" });
    return promise.then(() => {
      assert.strictEqual(out.core.stats().jobs.recover.calls, 1);
      assert.ok(out.core.statsLine().includes("jobs=recover:1/"), out.core.statsLine());
    });
  });

  const src = findSrcDir();
  if (!src) {
    skip("T5 essRepositoryFast vendor facts and loader hook", "EveJS server/src not found above the mod");
    return;
  }

  test("T5 essRepositoryFast vendor facts: fingerprints, the table's writers, the requirers of essRepository, sync "
    + "callbacks, row groups, knownChangedPaths; the loader wraps on the first load only with a flag", () => {
    const readFile = (p) => fs.readFileSync(p, "utf8");
    assert.deepStrictEqual(fast.fingerprintFiles(src, readFile), { ok: true });
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) files.push(full);
      }
    };
    walk(src);
    const rel = (f) => path.relative(src, f).split(path.sep).join("/");
    const withTable = [];
    const requirers = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      if (text.includes(TABLE)) withTable.push(rel(f));
      if (text.includes("essRepository")) requirers.push([rel(f), text]);
    }
    assert.deepStrictEqual(withTable.sort(), ["gameStore/index.js",
      "gameStore/shared-schema/dynamicResourceSchema.js", "gameStore/shared-schema/install.js",
      "gameStore/shared-schema/version.js", "gameStore/sqliteStore.js",
      "gameStore/tableOwnership.js", "services/dynamic/essRepository.js"]);
    assert.deepStrictEqual(requirers.map(([f]) => f).sort(), ["services/dynamic/dynamicBountyRuntime.js",
      "services/dynamic/dynamicResourceState.js", "services/dynamic/essReserveRuntime.js",
      "services/dynamic/essSettlementRuntime.js"]);
    for (const [f, text] of requirers) {
      assert.strictEqual(text.split("essRepository").length - 1, 1, `${f}: one mention`);
      assert.ok(text.includes('const repository = require("./essRepository");'), f);
      assert.ok(!/mutate\(\s*async/.test(text), `${f}: async mutate callback`);
    }
    const sqlite = fs.readFileSync(path.join(src, "gameStore", "sqliteStore.js"), "utf8");
    assert.ok(sqlite.includes('dynamicResourceRuntime: ["systems", "funding", "settlements", "unlocks", "losses"],'));
    const index = fs.readFileSync(path.join(src, "gameStore", "index.js"), "utf8");
    assert.ok(index.includes("const changedSegments = getKnownRootWriteSegments(options.knownChangedPaths);"));
    assert.ok(index.includes("markRootWriteDirty(table, changedSegments);"));
    const holders = files.filter((f) => fs.readFileSync(f, "utf8").includes("holdTableFlush(")).map(rel).sort();
    assert.deepStrictEqual(holders, ["gameStore/index.js", "gameStore/tableRepository.js",
      "services/bounty/bountyRuntime.js"]);

    const essFile = path.join(src, "services", "dynamic", "essRepository.js");
    const runLoader = (essCfg) => {
      const store = fakeStore(initialState());
      const essModule = { exports: {} };
      const fakeRequire = (request) => {
        assert.strictEqual(request, "../../gameStore/tableRepository");
        return { createTableRepository: () => store };
      };
      vm.runInThisContext(NodeModule.wrap(fs.readFileSync(essFile, "utf8")), { filename: essFile })(
        essModule.exports, fakeRequire, essModule, essFile, path.dirname(essFile));
      const essExports = essModule.exports;
      const original = essExports.read;
      const cache = {
        [essFile]: { exports: essExports },
        [path.join(src, "gameStore", "index.js")]: { exports: { read: store.read, write: store.write,
          readPersisted: store.readPersisted } },
        [path.join(src, "gameStore", "tableRepository.js")]: { exports: { createTableRepository: () => store } },
        [path.join(src, "gameStore", "sqliteStore.js")]: { exports: { rowGroupsFor: () => [...GROUPS] } },
      };
      const lines = [];
      const moduleApi = { _cache: cache, _load: (request) => (request === "./essRepository" ? essExports : {}) };
      const ctx = { state: {}, moduleApi, setTimer: () => ({ cancel: () => {} }),
        logger: { log: (l) => lines.push(l), logError: (l) => lines.push(l), debug: () => {} },
        loadConfig: () => ({ ok: true, sources: {}, warnings: [], errors: [],
          config: { enabled: true, world: { essRepository: essCfg } } }) };
      loader.installModuleHook(moduleApi, loader.buildHooks(ctx), silent);
      const parent = { filename: path.join(src, "services", "dynamic", "essSettlementRuntime.js") };
      moduleApi._load("./essRepository", parent);
      return { ctx, essExports, original, store, lines };
    };
    const on = runLoader({ fastReadEnabled: true, statsEnabled: false, parityEvery: 1, statsLogMinutes: 15 });
    assert.notStrictEqual(on.essExports.read, on.original);
    assert.strictEqual(on.ctx.state.essRepositoryFast, "on", on.lines.join("\n"));
    on.essExports.mutate((root) => { root.systems[SYS_A].mainValue = 8; });
    assert.strictEqual(on.ctx.state.essRepositoryFastCore.state(), "on");
    assert.ok(Array.isArray(on.store.writes[0].options.knownChangedPaths), "commit with a hint");
    assert.deepStrictEqual(explode(on.store.cache[TABLE]), on.store.disk);
    assert.ok(on.lines.includes("essRepositoryFast: on parityEvery=1"), on.lines.join("\n"));
    const off = runLoader({ fastReadEnabled: false, statsEnabled: false, parityEvery: 0, statsLogMinutes: 15 });
    assert.strictEqual(off.essExports.read, off.original);
    assert.strictEqual(off.ctx.state.essRepositoryFast, "disabled");
  });
};
