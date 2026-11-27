// Semantics adapted from essRepository.js (EveJS): the same root shape and key order, the same write order (store.write, flushTableSync, rollback with force:true), the same errors.

"use strict";

const crypto = require("node:crypto");
const nodePath = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { flushTable } = require("./gameStoreFlush");
const { afterValue, isThenable } = require("./maybeAsync");

const TABLE_NAME = "dynamicResourceRuntime";
const GROUPS = Object.freeze(["systems", "funding", "settlements", "unlocks", "losses"]);
const ROW_KEY_SEP = "\u001f";
const DETAIL_MAX = 200;
const MS_PER_MINUTE = 60000;

const COUNTER_NAMES = Object.freeze(["read", "write", "mutate", "commitPartial", "commitFull", "fallback",
  "parityFail"]);
const JOB_KINDS = Object.freeze(["recover", "autopay", "pulse", "reserve-links", "unlock", "dbs", "link", "other"]);
const COMMIT_REASONS = Object.freeze(["partial", "stale", "badKey", "empty", "full"]);

const WRAPPED = Symbol.for("livingNewEden.essRepositoryFast");
const WRAPPED_JOB = Symbol.for("livingNewEden.essSettlementJobs");

const FILE_FINGERPRINTS = Object.freeze({
  "services/dynamic/essRepository.js": "f35723ec3e29277e428240cfe9b942932f17b35e",
  "services/dynamic/dynamicResourceState.js": "48fe655d5646c305da83a9a9ae20fd036da94f9e",
  "services/dynamic/essSettlementRuntime.js": "109f87490090b3260b906ad37cfd9ed9cb16d7d8",
  "services/dynamic/essReserveRuntime.js": "520c3e6d3933b3cc663b94ad5e643076549ffab2",
  "services/dynamic/dynamicBountyRuntime.js": "20ab6b313c678b8c9d7d079512edabb308e20f83",
});
const FUNCTION_FINGERPRINTS = Object.freeze({
  "gameStore/index.js": Object.freeze({
    read: "e107e2da6a0e7dcb22e40faf77e41c3c52bf15af",
    write: "d168c1e25c08e99d3e7e3acdcb6da4a470ad5af5",
    isSameValue: "c8cd580dd026545418c4ea53c91ed4588a50bfe9",
    getKnownRootWriteSegments: "dc03ead4c5aaa6a5cb37b07a47ea677991bf9907",
    markRootWriteDirty: "c9db4bef52967cc86d1ac5ce95123cde673139a2",
    markRowDirty: "df32ca6ba9e9ac6edee5ce330ae37f5151f5d916",
    flushTableSync: "095009139b47ee6512f9f3027bd29f1410938537",
    readPersisted: "300422729ed0bacb51c2be5709eba43150459440",
  }),
  "gameStore/tableRepository.js": Object.freeze({
    createTableRepository: "0ef0a47fb05806b359722c307bd54ed4a35efd17",
  }),
});
const OWNER_FUNCTIONS = Object.freeze(["read", "write", "mutate", "check"]);

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function lf(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function functionBody(sourceText, name) {
  const text = lf(sourceText || "");
  const start = new RegExp(`^function ${escapeRegExp(name)}\\(`, "m").exec(text);
  if (!start) return null;
  const end = /\n\}(\n|$)/g;
  end.lastIndex = start.index;
  const hit = end.exec(text);
  return hit ? text.slice(start.index, hit.index + 2) : null;
}

function fingerprintFunctions(sourceText, names) {
  const out = new Map();
  for (const name of names) {
    const body = functionBody(sourceText, name);
    out.set(name, body === null ? null : sha1(body));
  }
  return out;
}

function fingerprintFiles(srcDir, readFile) {
  for (const rel of Object.keys(FILE_FINGERPRINTS)) {
    const text = readFile(nodePath.join(srcDir, ...rel.split("/")));
    if (typeof text !== "string") return { ok: false, detail: `${rel} missing` };
    if (sha1(lf(text)) !== FILE_FINGERPRINTS[rel]) return { ok: false, detail: rel };
  }
  for (const rel of Object.keys(FUNCTION_FINGERPRINTS)) {
    const text = readFile(nodePath.join(srcDir, ...rel.split("/")));
    if (typeof text !== "string") return { ok: false, detail: `${rel} missing` };
    const expected = FUNCTION_FINGERPRINTS[rel];
    const got = fingerprintFunctions(text, Object.keys(expected));
    for (const name of Object.keys(expected)) {
      if (got.get(name) !== expected[name]) return { ok: false, detail: `${rel}#${name}` };
    }
  }
  return { ok: true };
}

function canonicalJson(value) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (typeof value.toJSON === "function") return canonicalJson(value.toJSON());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(",")}}`;
}

function orderedKeys(baseObj, removed, appended) {
  if (removed.size === 0 && appended.size === 0) return Object.keys(baseObj);
  const tmp = Object.create(null);
  for (const key of Object.keys(baseObj)) if (!removed.has(key)) tmp[key] = true;
  for (const key of appended) tmp[key] = true;
  return Object.keys(tmp);
}

function badEntityKey(key) {
  return key === "" || key.includes("/") || key.includes(ROW_KEY_SEP) || key === "__proto__";
}

function putKey(obj, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = value;
  }
}

function createGroup(name, baseObj, missing, o) {
  const target = {};
  const h = {
    name, base: baseObj, missing, proxy: null, overlay: new Map(), removed: new Set(), appended: new Set(),
    replaced: false, target,
  };
  const present = (key) => h.appended.has(key) || (!h.removed.has(key) && hasOwn(h.base, key));
  const valueOf = (key) => {
    if (h.overlay.has(key)) return h.overlay.get(key);
    const value = o.clone(h.base[key]);
    h.overlay.set(key, value);
    if (o.onMaterialize) o.onMaterialize(name);
    return value;
  };
  const replace = () => {
    if (h.replaced) return;
    for (const key of orderedKeys(h.base, h.removed, h.appended)) {
      Object.defineProperty(target, key, { value: valueOf(key), writable: true, enumerable: true, configurable: true });
    }
    h.replaced = true;
    if (o.onReplace) o.onReplace(name);
  };
  const handler = {
    get(t, key, receiver) {
      if (h.replaced || typeof key === "symbol" || !present(key)) return Reflect.get(t, key, receiver);
      return valueOf(key);
    },
    set(t, key, value, receiver) {
      if (h.replaced || typeof key === "symbol") return Reflect.set(t, key, value, receiver);
      if (!present(key)) h.appended.add(key);
      h.overlay.set(key, value);
      return true;
    },
    deleteProperty(t, key) {
      if (h.replaced || typeof key === "symbol") return Reflect.deleteProperty(t, key);
      if (!present(key)) return true;
      h.overlay.delete(key);
      if (h.appended.has(key)) h.appended.delete(key);
      else h.removed.add(key);
      return true;
    },
    has(t, key) {
      if (h.replaced || typeof key === "symbol") return Reflect.has(t, key);
      return present(key) || Reflect.has(t, key);
    },
    ownKeys(t) {
      if (h.replaced) return Reflect.ownKeys(t);
      return [...orderedKeys(h.base, h.removed, h.appended), ...Object.getOwnPropertySymbols(t)];
    },
    getOwnPropertyDescriptor(t, key) {
      if (h.replaced || typeof key === "symbol") return Reflect.getOwnPropertyDescriptor(t, key);
      if (!present(key)) return undefined;
      return { value: valueOf(key), writable: true, enumerable: true, configurable: true };
    },
    defineProperty(t, key, descriptor) {
      if (typeof key !== "symbol") replace();
      return Reflect.defineProperty(t, key, descriptor);
    },
    preventExtensions(t) {
      replace();
      return Reflect.preventExtensions(t);
    },
    setPrototypeOf(t, proto) {
      replace();
      return Reflect.setPrototypeOf(t, proto);
    },
  };
  h.proxy = new Proxy(target, handler);
  return h;
}

function buildSnapshotRoot(base, opts = {}) {
  const o = { groups: opts.groups || GROUPS, clone: opts.clone || structuredClone, onMaterialize: opts.onMaterialize,
    onReplace: opts.onReplace };
  const groups = new Map();
  const byProxy = new Map();
  const root = {};
  root.version = hasOwn(base, "version") ? o.clone(base.version) : 1;
  for (const name of o.groups) {
    if (!hasOwn(base, name) || isPlainObject(base[name])) {
      const missing = !hasOwn(base, name);
      const h = createGroup(name, missing ? {} : base[name], missing, o);
      groups.set(name, h);
      byProxy.set(h.proxy, h);
      root[name] = h.proxy;
    } else {
      root[name] = o.clone(base[name]);
    }
  }
  for (const key of Object.keys(base)) {
    if (key === "version" || o.groups.includes(key)) continue;
    putKey(root, key, o.clone(base[key]));
  }
  return { root, handle: { base, root, groups, byProxy, groupNames: o.groups, clone: o.clone } };
}

function plainOfGroup(h, cloneBase) {
  if (h.replaced) return h.target;
  const obj = {};
  for (const key of orderedKeys(h.base, h.removed, h.appended)) {
    const value = h.overlay.has(key) ? h.overlay.get(key) : (cloneBase ? cloneBase(h.base[key]) : h.base[key]);
    putKey(obj, key, value);
  }
  return obj;
}

function isUntouched(h) {
  return !h.replaced && h.overlay.size === 0 && h.removed.size === 0 && h.appended.size === 0;
}

function buildCommit(handle, live) {
  const { base, root } = handle;
  const next = {};
  const paths = [];
  let badKey = false;
  for (const key of Object.keys(root)) {
    const value = root[key];
    const h = handle.byProxy.get(value);
    if (h && h.name === key && !h.replaced) {
      if (isUntouched(h)) {
        putKey(next, key, h.missing ? {} : h.base);
        if (h.missing) paths.push(`/${key}`);
        continue;
      }
      putKey(next, key, plainOfGroup(h, null));
      if (h.missing) {
        paths.push(`/${key}`);
        continue;
      }
      const changed = new Set([...h.overlay.keys(), ...h.removed]);
      for (const entityKey of changed) {
        if (badEntityKey(entityKey)) badKey = true;
        paths.push(`/${key}/${entityKey}`);
      }
      continue;
    }
    if (h) {
      putKey(next, key, plainOfGroup(h, null));
      if (badEntityKey(key)) badKey = true;
      paths.push(`/${key}`);
      continue;
    }
    if (value !== null && typeof value === "object" && handle.byProxy.size > 0 && containsProxy(value, handle)) {
      throw new Error("ESS_FAST_NESTED_PROXY");
    }
    putKey(next, key, value);
    if (handle.groupNames.includes(key) || !hasOwn(base, key) || !isDeepStrictEqual(value, base[key])) {
      if (badEntityKey(key)) badKey = true;
      paths.push(`/${key}`);
    }
  }
  for (const key of Object.keys(base)) {
    if (!hasOwn(root, key)) {
      if (badEntityKey(key)) badKey = true;
      paths.push(`/${key}`);
    }
  }
  if (live !== base) return { next, paths: null, reason: "stale" };
  if (badKey) return { next, paths: null, reason: "badKey" };
  if (paths.length === 0) return { next, paths: null, reason: "empty" };
  return { next, paths, reason: "partial" };
}

function containsProxy(value, handle) {
  for (const key of Object.keys(value)) {
    if (handle.byProxy.has(value[key])) return true;
  }
  return false;
}

function buildCommitFull(handle) {
  const next = {};
  for (const key of Object.keys(handle.root)) {
    const value = handle.root[key];
    const h = handle.byProxy.get(value);
    putKey(next, key, h ? plainOfGroup(h, handle.clone) : value);
  }
  return { next, paths: null, reason: "full" };
}

function previousRoot(live) {
  const root = { version: 1 };
  for (const name of GROUPS) root[name] = {};
  for (const key of Object.keys(live)) putKey(root, key, live[key]);
  return root;
}

function emptyTimer() {
  return { calls: 0, sumMs: 0, maxMs: 0 };
}

function emptyWindow() {
  return {
    read: emptyTimer(), write: emptyTimer(), mutate: emptyTimer(),
    materialized: Object.fromEntries(GROUPS.map((g) => [g, 0])),
    commits: Object.fromEntries(COMMIT_REASONS.map((r) => [r, 0])),
    fallbacks: { error: 0, vendorWrite: 0, shape: 0, replaced: 0 },
    parity: { checks: 0, fails: 0 },
    jobs: {},
  };
}

function addTimer(timer, ms) {
  timer.calls += 1;
  timer.sumMs += ms;
  if (ms > timer.maxMs) timer.maxMs = ms;
}

function fmtTimer(t) {
  return `${t.calls}/${Math.round(t.sumMs)}ms/max${Math.round(t.maxMs)}`;
}

function createEssRepositoryFast(o) {
  const originals = o.originals;
  const repo = o.tableRepo || null;
  const table = o.tableName || TABLE_NAME;
  const groups = o.groups || GROUPS;
  const clone = o.clone || structuredClone;
  const now = o.now || (() => performance.now());
  const log = o.log || (() => {});
  const onCount = o.onCount || (() => {});
  const parityEvery = Number.isSafeInteger(o.parityEvery) && o.parityEvery > 0 ? o.parityEvery : 0;
  const fast = o.fast === true && repo !== null;
  const roots = new WeakMap();
  let disabledReason = null;
  let commitCount = 0;
  let pendingGeneration = null;
  let win = emptyWindow();

  function disable(reason, detail) {
    if (disabledReason) return;
    disabledReason = reason;
    log(`WARN essRepositoryFast disabled: ${reason}${detail ? ` (${fit(detail)})` : ""} - vendor clones from now on`);
  }

  function isOn() {
    return fast && disabledReason === null;
  }

  function state() {
    if (disabledReason) return `disabled:${disabledReason}`;
    return fast ? "on" : "stats";
  }

  const snapshotOpts = {
    groups, clone,
    onMaterialize: (group) => {
      if (hasOwn(win.materialized, group)) win.materialized[group] += 1;
    },
    onReplace: () => {
      win.fallbacks.replaced += 1;
    },
  };

  function liveBase() {
    repo.ensureTable(table);
    return originals.check(repo.read(table, "/")) || {};
  }

  function snapshotOf(base) {
    if (!isPlainObject(base)) {
      win.fallbacks.shape += 1;
      return null;
    }
    try {
      const built = buildSnapshotRoot(base, snapshotOpts);
      roots.set(built.root, built.handle);
      return built.root;
    } catch (err) {
      win.fallbacks.error += 1;
      onCount("fallback");
      disable("error", err && err.message);
      return null;
    }
  }

  function checkGeneration() {
    if (!pendingGeneration) return;
    const pending = pendingGeneration;
    pendingGeneration = null;
    let same;
    try {
      same = canonicalJson(pending.generation) === pending.json;
    } catch (_err) {
      same = false;
    }
    if (!same) parityFailed("generation changed in place");
  }

  function parityFailed(detail) {
    win.parity.fails += 1;
    onCount("parityFail");
    disable("parity", detail);
    try {
      const current = repo.read(table, "/");
      if (current && current.success === true && current.data) {
        repo.write(table, "/", current.data, { force: true });
        const raw = typeof o.flushRepair === "function" ? o.flushRepair(table) : repo.flushTableSync(table);
        const settled = afterValue(raw, (r) => {
          if (!r || r.success !== true) repairFailed(r && r.errorMsg);
        }, (err) => repairFailed(err && err.message));
        if (isThenable(settled)) settled.catch(() => undefined);
      }
    } catch (err) {
      repairFailed(err && err.message);
    }
  }

  function repairFailed(detail) {
    log(`WARN essRepositoryFast parity repair flush failed (${fit(detail)})`);
  }

  function runParity() {
    if (typeof o.readPersisted !== "function") return;
    win.parity.checks += 1;
    let cacheJson;
    let diskJson;
    let cacheData = null;
    try {
      const current = repo.read(table, "/");
      cacheData = current && current.success === true ? current.data : null;
      cacheJson = canonicalJson(cacheData);
      const disk = o.readPersisted(table, "/");
      diskJson = disk && disk.success === true ? canonicalJson(disk.data) : `!${disk && disk.errorMsg}`;
    } catch (err) {
      diskJson = `!${err && err.message}`;
    }
    if (cacheJson !== diskJson) {
      parityFailed("readPersisted differs from the cache");
      return;
    }
    pendingGeneration = { generation: cacheData, json: cacheJson };
  }

  function commit(handle) {
    checkGeneration();
    const live = liveBase();
    let out;
    try {
      out = buildCommit(handle, live);
    } catch (err) {
      win.fallbacks.error += 1;
      onCount("fallback");
      disable("error", err && err.message);
      out = buildCommitFull(handle);
    }
    win.commits[out.reason] += 1;
    if (out.reason === "partial") onCount("commitPartial");
    else if (out.reason !== "empty") onCount("commitFull");
    originals.check(repo.write(table, "/", out.next, out.paths ? { knownChangedPaths: out.paths } : undefined));
    let flush;
    try {
      flush = repo.flushTableSync(table);
      originals.check(flush);
    } catch (error) {
      const restored = repo.write(table, "/", previousRoot(live), { force: true });
      if (restored && restored.success && flush && flush.errorMsg === "FLUSH_ERROR" && error && typeof error === "object") {
        error.code = "DYNAMIC_RESOURCE_FLUSH_ERROR";
      }
      throw error;
    }
    commitCount += 1;
    if (parityEvery > 0 && commitCount % parityEvery === 0 && disabledReason === null) runParity();
  }

  function timed(timer, fn) {
    const t0 = now();
    try {
      return fn();
    } finally {
      addTimer(timer, now() - t0);
    }
  }

  const api = {
    read: function essRepositoryFastRead() {
      const self = this;
      const args = arguments;
      onCount("read");
      return timed(win.read, () => {
        if (!isOn()) return originals.read.apply(self, args);
        const root = snapshotOf(liveBase());
        return root === null ? originals.read.apply(self, args) : root;
      });
    },
    write: function essRepositoryFastWrite(next) {
      const self = this;
      const args = arguments;
      onCount("write");
      return timed(win.write, () => {
        const handle = isOn() && next !== null && typeof next === "object" ? roots.get(next) : undefined;
        if (!handle) {
          if (isOn()) win.fallbacks.vendorWrite += 1;
          return originals.write.apply(self, args);
        }
        commit(handle);
        return undefined;
      });
    },
    mutate: function essRepositoryFastMutate(callback) {
      const self = this;
      const args = arguments;
      onCount("mutate");
      return timed(win.mutate, () => {
        if (!isOn()) return originals.mutate.apply(self, args);
        const root = snapshotOf(liveBase());
        if (root === null) return originals.mutate.apply(self, args);
        const result = callback(root);
        commit(roots.get(root));
        return result;
      });
    },
  };

  function noteJob(job, ms) {
    const raw = job && job.payload && job.payload.kind;
    const kind = JOB_KINDS.includes(raw) ? raw : "other";
    if (!win.jobs[kind]) win.jobs[kind] = emptyTimer();
    addTimer(win.jobs[kind], ms);
  }

  function stats() {
    const w = win;
    return {
      mode: state(),
      read: { ...w.read }, write: { ...w.write }, mutate: { ...w.mutate },
      vanillaCloneEstimate: w.read.calls + 2 * w.mutate.calls + w.write.calls,
      materialized: { ...w.materialized }, commits: { ...w.commits }, fallbacks: { ...w.fallbacks },
      parity: { ...w.parity },
      jobs: Object.fromEntries(Object.keys(w.jobs).map((k) => [k, { ...w.jobs[k] }])),
    };
  }

  function hasActivity() {
    const w = win;
    return w.read.calls + w.write.calls + w.mutate.calls + Object.keys(w.jobs).length > 0;
  }

  function statsLine(exportsObj) {
    const s = stats();
    const m = s.materialized;
    const order = exportsObj && (exportsObj.read !== api.read || exportsObj.write !== api.write
      || exportsObj.mutate !== api.mutate) ? " order=replaced" : "";
    const jobs = JOB_KINDS.filter((k) => s.jobs[k]).map((k) => `${k}:${s.jobs[k].calls}/${Math.round(s.jobs[k].sumMs)}ms`);
    return `essRepository stats state=${s.mode}${order} read=${fmtTimer(s.read)} write=${fmtTimer(s.write)} `
      + `mutate=${fmtTimer(s.mutate)} vanillaClones~${s.vanillaCloneEstimate} `
      + `materialized=sys:${m.systems},fund:${m.funding},set:${m.settlements},unl:${m.unlocks},loss:${m.losses} `
      + `commits=partial:${s.commits.partial},stale:${s.commits.stale},badKey:${s.commits.badKey},`
      + `empty:${s.commits.empty},full:${s.commits.full} `
      + `fallback=error:${s.fallbacks.error},vendorWrite:${s.fallbacks.vendorWrite},shape:${s.fallbacks.shape},`
      + `replaced:${s.fallbacks.replaced} parity=${s.parity.checks}/${s.parity.fails} `
      + `jobs=${jobs.length > 0 ? jobs.join(",") : "-"}`;
  }

  function resetWindow() {
    win = emptyWindow();
  }

  return { api, state, disable, stats, statsLine, resetWindow, hasActivity, noteJob, isOn };
}

function locateSrcDir(essExports, requireCache) {
  if (!requireCache || typeof requireCache !== "object") return null;
  for (const file of Object.keys(requireCache)) {
    const entry = requireCache[file];
    if (!entry || entry.exports !== essExports) continue;
    if (!file.replace(/\\/g, "/").endsWith("/services/dynamic/essRepository.js")) continue;
    return nodePath.dirname(nodePath.dirname(nodePath.dirname(file)));
  }
  return null;
}

function cachedExports(requireCache, absPath) {
  const entry = requireCache[absPath];
  return entry && entry.exports ? entry.exports : null;
}

function ownerFunctionsMatch(essExports, sourceText) {
  for (const name of OWNER_FUNCTIONS) {
    const body = functionBody(sourceText, name);
    if (body === null || lf(Function.prototype.toString.call(essExports[name])) !== body) return name;
  }
  return null;
}

function install(essExports, deps) {
  const cfg = deps.config || {};
  if (cfg.fast !== true && cfg.stats !== true) return { ok: false, reason: "disabled" };
  if (essExports === null || typeof essExports !== "object") return { ok: false, reason: "shape", detail: "exports" };
  if (essExports[WRAPPED]) return { ok: true, core: essExports[WRAPPED], alreadyInstalled: true };
  for (const name of OWNER_FUNCTIONS) {
    if (typeof essExports[name] !== "function") return { ok: false, reason: "shape", detail: name };
  }
  if (essExports.TABLE_NAME !== TABLE_NAME) return { ok: false, reason: "shape", detail: "TABLE_NAME" };
  const originals = { read: essExports.read, write: essExports.write, mutate: essExports.mutate,
    check: essExports.check };
  const common = { originals, tableName: TABLE_NAME, groups: GROUPS, parityEvery: cfg.parityEvery,
    now: deps.now, log: deps.log, onCount: deps.onCount };

  let drift = null;
  let fastDeps = null;
  if (cfg.fast === true) {
    const srcDir = locateSrcDir(essExports, deps.requireCache);
    if (!srcDir) return { ok: false, reason: "locate" };
    drift = checkVendor(essExports, srcDir, deps);
    if (drift === null) {
      const store = cachedExports(deps.requireCache, nodePath.join(srcDir, "gameStore", "index.js"));
      const repoModule = cachedExports(deps.requireCache, nodePath.join(srcDir, "gameStore", "tableRepository.js"));
      fastDeps = { tableRepo: repoModule.createTableRepository("service:dynamic"),
        flushRepair: typeof store.flushTableDurable === "function" ? (t) => flushTable(store, t) : undefined,
        readPersisted: typeof store.readPersisted === "function"
          ? (t, p) => store.readPersisted(t, p) : undefined };
    }
  }
  const core = createEssRepositoryFast({ ...common, ...(fastDeps || {}), fast: fastDeps !== null });
  if (drift !== null) core.disable("drift", drift);
  essExports.read = core.api.read;
  essExports.write = core.api.write;
  essExports.mutate = core.api.mutate;
  Object.defineProperty(essExports, WRAPPED, { value: core, configurable: true });
  if (drift !== null) return { ok: false, reason: "drift", detail: drift, statsCore: core };
  return { ok: true, core };
}

function checkVendor(essExports, srcDir, deps) {
  const readFile = typeof deps.readFile === "function" ? deps.readFile : () => null;
  const files = fingerprintFiles(srcDir, readFile);
  if (!files.ok) return files.detail;
  const owner = ownerFunctionsMatch(essExports,
    readFile(nodePath.join(srcDir, "services", "dynamic", "essRepository.js")));
  if (owner !== null) return `exports.${owner} is not the vendor function`;
  const store = cachedExports(deps.requireCache, nodePath.join(srcDir, "gameStore", "index.js"));
  const repoModule = cachedExports(deps.requireCache, nodePath.join(srcDir, "gameStore", "tableRepository.js"));
  const sqlite = cachedExports(deps.requireCache, nodePath.join(srcDir, "gameStore", "sqliteStore.js"));
  if (!store || typeof store.write !== "function" || typeof store.read !== "function") return "gameStore/index";
  if (!repoModule || typeof repoModule.createTableRepository !== "function") return "gameStore/tableRepository";
  if (!sqlite || typeof sqlite.rowGroupsFor !== "function") return "gameStore/sqliteStore";
  let rowGroups;
  try {
    rowGroups = sqlite.rowGroupsFor(TABLE_NAME);
  } catch (err) {
    return `rowGroupsFor threw (${err && err.message})`;
  }
  if (!isDeepStrictEqual(Array.isArray(rowGroups) ? [...rowGroups] : rowGroups, [...GROUPS])) return "rowGroupsFor";
  return null;
}

function wrapHandleJob(settlementExports, sink, now = () => performance.now()) {
  const original = settlementExports && settlementExports.handleJob;
  if (typeof original !== "function" || !sink || typeof sink.noteJob !== "function") {
    return { ok: false, reason: "missing" };
  }
  if (original[WRAPPED_JOB]) return { ok: false, reason: "already_wrapped" };
  const wrapped = function essHandleJobCounted(job) {
    const t0 = now();
    const done = () => {
      try {
        sink.noteJob(job, now() - t0);
      } catch (_err) {
      }
    };
    let result;
    try {
      result = original.apply(this, arguments);
    } catch (err) {
      done();
      throw err;
    }
    if (result && typeof result.then === "function") {
      result.then(done, done);
      return result;
    }
    done();
    return result;
  };
  Object.defineProperty(wrapped, WRAPPED_JOB, { value: original });
  settlementExports.handleJob = wrapped;
  return { ok: true };
}

function statsPeriodMs(minutes) {
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes * MS_PER_MINUTE : 0;
}

module.exports = {
  TABLE_NAME, GROUPS, COUNTER_NAMES, JOB_KINDS, COMMIT_REASONS, WRAPPED, WRAPPED_JOB,
  FILE_FINGERPRINTS, FUNCTION_FINGERPRINTS,
  buildSnapshotRoot, buildCommit, buildCommitFull, canonicalJson, createEssRepositoryFast,
  fingerprintFiles, fingerprintFunctions, functionBody, install, wrapHandleJob, statsPeriodMs,
};
