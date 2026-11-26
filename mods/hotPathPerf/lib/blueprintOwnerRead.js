"use strict";

const crypto = require("crypto");

const DETAIL_MAX = 200;
const BLUEPRINT_STATE_TABLE = "industryBlueprintState";
const JOBS_TABLE = "industryJobs";
const BLUEPRINT_CATEGORY_ID = 9;
const TABLE_GROUPS = Object.freeze({ [BLUEPRINT_STATE_TABLE]: "records", [JOBS_TABLE]: "jobs" });

const INDUSTRY_FUNCTIONS = Object.freeze([
  "readTable", "writeTable", "ensureBlueprintStateTable", "persistBlueprintStateTable", "ensureJobsTable",
  "getStoredBlueprintState", "getVerifiedInstalledBlueprintJob", "shouldHideUnprotectedInstalledBlueprint",
  "canViewBlueprintInstance", "getBlueprintState", "buildBlueprintInstance", "listBlueprintInstancesByOwner",
  "getBlueprintByItemID", "getJobByID", "getJobStatus", "resolveLocationType", "resolveIndustryLocationFlagID",
]);
const STARBASE_FUNCTIONS = Object.freeze(["getArrayContext", "getAssemblyArray", "canAccessArray"]);

const FINGERPRINTS = Object.freeze({
  industry: Object.freeze({
    readTable: "ee73113c750247c530021bbcab10ea3ede6c7b45",
    writeTable: "a74819a540785f58c7953630a15133930ad4773d",
    ensureBlueprintStateTable: "a7b0dfdc1760338c17cb0ee63270f5cc0d0ad700",
    persistBlueprintStateTable: "4f352e4a28197abc78513691b401be7357ed9cc7",
    ensureJobsTable: "6daf0a26f0a3ef306f0c26e4f42c63fee7ea73dc",
    getStoredBlueprintState: "49c9e6f11efc8585c8b61d0dc219a4d5f4239233",
    getVerifiedInstalledBlueprintJob: "51412221d78d9bd2cfd7373d3ebae8c5bb7ac9b0",
    shouldHideUnprotectedInstalledBlueprint: "c25c6bdf8de0cc2ac478017bf98cd88f4472df01",
    canViewBlueprintInstance: "8b6c681a51d5f96235769325b27eb6e7e64beeff",
    getBlueprintState: "4091b690d4fbab2b7ee30e7bf9867fd9373079c6",
    buildBlueprintInstance: "278e84c7e259b33e9153be8fbcd20466d815df55",
    listBlueprintInstancesByOwner: "38f958034266d7a00cc52cca614c96122607cf41",
    getBlueprintByItemID: "92699caa5242140d6435827e38fdd162772ce9a4",
    getJobByID: "e5c71747ed960ce7c85c6419e2a3848d5b79050a",
    getJobStatus: "d0a4a5d16e68991d1c2a932c45214e70fc981b45",
    resolveLocationType: "1e4c2ebf934d730e99a4ef881fac75dd5f61ff40",
    resolveIndustryLocationFlagID: "7e5d5a1fdb14bd3b53560fdca22c87cfa7bc0790",
  }),
  starbase: Object.freeze({
    getArrayContext: "694575db58b193b0b718515eeacd33de59c1fb4f",
    getAssemblyArray: "e1fb0c8f9a33380a1329e00ff965a76818d395d0",
    canAccessArray: "ebaf530c6b6b477a4f3d6885ceaa34d168582785",
  }),
});

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function isRootPath(pth) {
  return pth === undefined || pth === null || pth === "" || pth === "/";
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fingerprintFunctions(sourceText, names) {
  const text = String(sourceText || "").replace(/\r\n/g, "\n");
  const out = new Map();
  for (const name of names) {
    const start = new RegExp(`^function ${escapeRegExp(name)}\\(`, "m").exec(text);
    if (!start) {
      out.set(name, null);
      continue;
    }
    const end = /\n\}(\n|$)/g;
    end.lastIndex = start.index;
    const hit = end.exec(text);
    if (!hit) {
      out.set(name, null);
      continue;
    }
    const body = text.slice(start.index, hit.index + 2);
    out.set(name, crypto.createHash("sha1").update(body).digest("hex"));
  }
  return out;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

function sameJson(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_error) {
    return false;
  }
}

function viewOf(data, group, key) {
  const view = {};
  for (const k of Object.keys(data)) {
    if (k !== group) view[k] = data[k];
  }
  const entities = data[group];
  const picked = {};
  if (key !== null && isObject(entities) && hasOwn(entities, key)) picked[key] = entities[key];
  view[group] = picked;
  return view;
}

function firstDifferentItem(fast, vendor) {
  const a = fast.blueprints || [];
  const b = (vendor && vendor.blueprints) || [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (canonical(a[i]) !== canonical(b[i])) return String(toInt((a[i] || b[i] || {}).itemID, 0));
  }
  return "none";
}

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, "__hotPathPerfBlueprint", { value: original });
  return wrapper;
}

function functionText(text, name) {
  const start = new RegExp(`^function ${escapeRegExp(name)}\\(`, "m").exec(text);
  if (!start) return "";
  const end = /\n\}(\n|$)/g;
  end.lastIndex = start.index;
  const hit = end.exec(text);
  return hit ? text.slice(start.index, hit.index + 2) : "";
}

function fixedUpstream(industrySource) {
  const text = String(industrySource || "").replace(/\r\n/g, "\n");
  if (!/^function readTableView\(/m.test(text)) return false;
  const stored = functionText(text, "getStoredBlueprintState");
  const job = functionText(text, "getJobByID");
  return stored.includes("readTableView(") && !stored.includes("ensureBlueprintStateTable(") &&
    job.includes("readJobsView()") && !job.includes("ensureJobsTable(");
}

function emptyWindow() {
  return { calls: 0, items: 0, itemsMax: 0, sumMs: 0, maxMs: 0, scopedReads: 0, scopedWrites: 0, fallback: {}, parityChecks: 0 };
}

function createBlueprintOwnerRead(o) {
  const config = o.config;
  const log = o.log;
  const now = o.now || Date.now;
  const fingerprints = o.fingerprints || FINGERPRINTS;
  const priv = {
    deps: null,
    gameRead: null,
    gameWrite: null,
    fingerprintOk: false,
    disabledReason: null,
    depth: 0,
    current: null,
    window: emptyWindow(),
  };

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    priv.disabledReason = reason;
    log(`WARN blueprintOwnerRead disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function setDeps(deps) {
    if (!deps || typeof deps.listOwnedItems !== "function" || typeof deps.getBlueprintByItemID !== "function") return false;
    priv.deps = { listOwnedItems: deps.listOwnedItems, getBlueprintByItemID: deps.getBlueprintByItemID };
    if (typeof deps.gameRead === "function") priv.gameRead = deps.gameRead;
    if (typeof deps.gameWrite === "function") priv.gameWrite = deps.gameWrite;
    return true;
  }

  function checkFingerprint(sources) {
    const groups = [
      ["industry", INDUSTRY_FUNCTIONS, sources && sources.industrySource],
      ["starbase", STARBASE_FUNCTIONS, sources && sources.starbaseSource],
    ];
    for (const [group, names, text] of groups) {
      const got = fingerprintFunctions(text, names);
      for (const name of names) {
        if (got.get(name) === null || got.get(name) !== fingerprints[group][name]) {
          return { ok: false, reason: "drift", detail: name };
        }
      }
    }
    priv.fingerprintOk = true;
    return { ok: true };
  }

  function isOn() {
    return priv.disabledReason === null && priv.fingerprintOk && priv.deps !== null &&
      priv.gameRead !== null && priv.gameWrite !== null;
  }

  function state() {
    if (config.blueprintOwnerRead !== true) return "off";
    if (priv.disabledReason) return `disabled:${priv.disabledReason}`;
    return isOn() ? "on" : "waiting";
  }

  function runScoped(itemID, fn) {
    const prev = priv.current;
    priv.current = { itemKey: String(toInt(itemID, 0)) };
    priv.depth += 1;
    try {
      return fn();
    } finally {
      priv.depth -= 1;
      priv.current = prev;
    }
  }

  function wrapRead(original) {
    if (!priv.gameRead) priv.gameRead = original;
    const wrapped = function hotPathPerfBlueprintRead(table, pth) {
      if (priv.depth === 0) return original.apply(this, arguments);
      const group = hasOwn(TABLE_GROUPS, table) ? TABLE_GROUPS[table] : null;
      if (!group || !isRootPath(pth)) return original.apply(this, arguments);
      priv.window.scopedReads += 1;
      const live = original.call(this, table, "/");
      if (!live || live.success !== true || !isObject(live.data)) return live;
      let key = priv.current.itemKey;
      if (table === JOBS_TABLE) {
        const bp = original.call(this, BLUEPRINT_STATE_TABLE, "/");
        const records = bp && bp.success === true && isObject(bp.data) && isObject(bp.data.records) ? bp.data.records : null;
        const record = records && hasOwn(records, key) ? records[key] : null;
        const jobID = toInt(record && record.jobID, 0);
        key = jobID > 0 ? String(jobID) : null;
      }
      return { success: true, errorMsg: null, data: viewOf(live.data, group, key) };
    };
    return markWrapped(wrapped, original);
  }

  function wrapWrite(original) {
    if (!priv.gameWrite) priv.gameWrite = original;
    const wrapped = function hotPathPerfBlueprintWrite(table, pth, data) {
      if (priv.depth === 0) return original.apply(this, arguments);
      const group = hasOwn(TABLE_GROUPS, table) ? TABLE_GROUPS[table] : null;
      if (!group || !isRootPath(pth) || !isObject(data)) return original.apply(this, arguments);
      priv.window.scopedWrites += 1;
      const extra = Array.prototype.slice.call(arguments, 3);
      const liveResult = priv.gameRead.call(this, table, "/");
      const liveData = liveResult && liveResult.success === true && isObject(liveResult.data) ? liveResult.data : {};
      const liveGroup = isObject(liveData[group]) ? liveData[group] : {};
      const entities = isObject(data[group]) ? data[group] : {};
      const writes = [];
      for (const key of Object.keys(entities)) {
        if (!hasOwn(liveGroup, key) || !sameJson(liveGroup[key], entities[key])) writes.push([`/${group}/${key}`, entities[key]]);
      }
      for (const key of Object.keys(data)) {
        if (key === group) continue;
        if (!hasOwn(liveData, key) || !sameJson(liveData[key], data[key])) writes.push([`/${key}`, data[key]]);
      }
      for (const [path, value] of writes) {
        const result = original.call(this, table, path, value, ...extra);
        if (!result || result.success !== true) return result;
      }
      return { success: true, errorMsg: null };
    };
    return markWrapped(wrapped, original);
  }

  function record(ms, items, mode, ownerID) {
    const w = priv.window;
    w.calls += 1;
    if (items >= 0) {
      w.items += items;
      if (items > w.itemsMax) w.itemsMax = items;
    }
    w.sumMs += ms;
    if (ms > w.maxMs) w.maxMs = ms;
    if (ms >= config.slowCallMs) {
      log(`slow industryRuntimeState.listBlueprintInstancesByOwner ${Math.round(ms)}ms owner=${toInt(ownerID, 0)}` +
        ` items=${items >= 0 ? items : "?"} mode=${mode}`);
    }
  }

  function fallback(reason) {
    priv.window.fallback[reason] = (priv.window.fallback[reason] || 0) + 1;
  }

  function wrapList(original) {
    const wrapped = function hotPathPerfBlueprintOwnerList(ownerID, facilityID = null, session = null) {
      const t0 = now();
      if (!isOn()) {
        fallback(priv.disabledReason || "waiting");
        const vendor = original.apply(this, arguments);
        record(now() - t0, -1, "vendor", ownerID);
        return vendor;
      }
      let items = 0;
      let result;
      try {
        const numericOwnerID = toInt(ownerID, 0);
        const numericFacilityID =
          facilityID === null || facilityID === undefined ? null : toInt(facilityID, 0);
        const counts = {};
        const blueprints = [];
        for (const item of priv.deps.listOwnedItems(numericOwnerID, { categoryID: BLUEPRINT_CATEGORY_ID })) {
          items += 1;
          const itemID = item && item.itemID;
          const instance = runScoped(itemID, () => priv.deps.getBlueprintByItemID(itemID, session));
          if (!instance) {
            continue;
          }
          const resolvedFacilityID =
            instance.facilityID === null || instance.facilityID === undefined
              ? null
              : toInt(instance.facilityID, 0);
          const countKey = resolvedFacilityID && resolvedFacilityID > 0
            ? String(resolvedFacilityID)
            : "null";
          counts[countKey] = (counts[countKey] || 0) + 1;
          if (numericFacilityID !== null && resolvedFacilityID !== numericFacilityID) {
            continue;
          }
          blueprints.push(instance);
        }
        blueprints.sort((left, right) => left.itemID - right.itemID);
        result = { blueprints, counts };
      } catch (error) {
        disable("error", String(error && error.message || error));
        fallback("error");
        const vendor = original.apply(this, arguments);
        record(now() - t0, items, "vendor", ownerID);
        return vendor;
      }
      if (config.blueprintOwnerReadParityCheck === true) {
        const vendor = original.apply(this, arguments);
        priv.window.parityChecks += 1;
        let same;
        try {
          same = canonical(result) === canonical(vendor);
        } catch (_error) {
          same = false;
        }
        record(now() - t0, items, "parity", ownerID);
        if (!same) {
          disable("parity", `owner=${toInt(ownerID, 0)} firstItem=${firstDifferentItem(result, vendor)}`);
          return vendor;
        }
        return result;
      }
      record(now() - t0, items, "fast", ownerID);
      return result;
    };
    return markWrapped(wrapped, original);
  }

  function statsLine() {
    const w = priv.window;
    const fb = Object.keys(w.fallback).sort().map((k) => `${k}:${w.fallback[k]}`).join(",");
    return `blueprintOwnerRead state=${state()} calls=${w.calls} items=${w.items} itemsMax=${w.itemsMax} ` +
      `sumMs=${Math.round(w.sumMs)} maxMs=${Math.round(w.maxMs)} scopedReads=${w.scopedReads} scopedWrites=${w.scopedWrites} ` +
      `fallback=${fb || "-"} parityChecks=${w.parityChecks}`;
  }

  function resetWindow() {
    priv.window = emptyWindow();
  }

  function status() {
    return { disabledReason: priv.disabledReason, state: state(), depth: priv.depth };
  }

  function statsSnapshot() {
    return { ...status(), ...priv.window, fallback: { ...priv.window.fallback } };
  }

  function drainStatsLines() {
    const line = `stats ${statsLine()}`;
    resetWindow();
    return [line];
  }

  return {
    setDeps, wrapList, wrapRead, wrapWrite, checkFingerprint, disable, state, statsLine, resetWindow,
    status, statsSnapshot, drainStatsLines, runScoped,
  };
}

module.exports = {
  createBlueprintOwnerRead, fingerprintFunctions, fixedUpstream, canonical, toInt,
  INDUSTRY_FUNCTIONS, STARBASE_FUNCTIONS, FINGERPRINTS, BLUEPRINT_STATE_TABLE, JOBS_TABLE, BLUEPRINT_CATEGORY_ID,
};
