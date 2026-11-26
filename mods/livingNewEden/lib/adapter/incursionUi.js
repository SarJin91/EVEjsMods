"use strict";

const crypto = require("node:crypto");
const nodePath = require("node:path");

const RUNTIME_PATH = "services/incursion/incursionRuntime";
const MAP_SERVICE_FILE = "services/map/mapService.js";
const RUNTIME_SHA1 = "16f1299e07b31b6f682055fc258bdc0e8562259f";
const MAP_HOLDS_MODULE = ["const incursionRuntime = require", "(path.join("].join("");
const MAP_CALL = "incursionRuntime.listActiveIncursions()";
const MAP_CALLS = 2;
const EXPORT_NAME = "listActiveIncursions";
const MARKER = Symbol.for("livingNewEden.incursionUiList");
const EMPTY_JSON = "[]";
const DETAIL_MAX = 200;

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function lf(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
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

function positiveId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function systemIdOf(entry) {
  if (typeof entry === "number") return positiveId(entry);
  return entry && typeof entry === "object" ? positiveId(entry.locationID || entry.solarSystemID) : 0;
}

function systemsOf(incursion) {
  const out = [];
  const staging = positiveId(incursion.stagingSolarSystemID || incursion.solarSystemID);
  if (staging > 0) out.push(staging);
  for (const key of ["incursedSystems", "systems"]) {
    const list = incursion[key];
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      const id = systemIdOf(s);
      if (id > 0) out.push(id);
    }
  }
  return out;
}

function createIncursionUiPublisher(deps) {
  const requireGame = deps && typeof deps.requireGame === "function" ? deps.requireGame : null;
  const serverSrc = deps && typeof deps.serverSrc === "function" ? deps.serverSrc : () => null;
  const readFile = deps && typeof deps.readFile === "function" ? deps.readFile : () => null;

  let slot = { entriesJson: EMPTY_JSON, calls: 0, merged: 0, lastSuppressed: 0, errors: 0 };
  let installed = false;
  let driftResult = null;

  function readText(srcDir, rel) {
    try {
      const text = readFile(nodePath.join(srcDir, ...rel.split("/")));
      return typeof text === "string" ? lf(text) : null;
    } catch (_err) {
      return null;
    }
  }

  function fingerprintDetail(srcDir, runtime) {
    const runtimeText = readText(srcDir, `${RUNTIME_PATH}.js`);
    if (runtimeText === null) return `${RUNTIME_PATH}.js missing`;
    if (sha1(runtimeText) !== RUNTIME_SHA1) return `${RUNTIME_PATH}.js sha1`;
    const mapText = readText(srcDir, MAP_SERVICE_FILE);
    if (mapText === null) return `${MAP_SERVICE_FILE} missing`;
    if (!mapText.includes(MAP_HOLDS_MODULE)) return `${MAP_SERVICE_FILE} module object`;
    if (mapText.split(MAP_CALL).length - 1 !== MAP_CALLS) return `${MAP_SERVICE_FILE} call sites`;
    const current = runtime[EXPORT_NAME];
    if (typeof current !== "function") return `${EXPORT_NAME} missing`;
    if (current[MARKER] && typeof current[MARKER] === "object") return null;
    if (lf(String(current)) !== functionBody(runtimeText, EXPORT_NAME)) return `${EXPORT_NAME} not the vendor function`;
    return null;
  }

  function makeWrapper(original, shared) {
    const wrapper = function lneListActiveIncursions(...args) {
      const v = original.apply(this, args);
      if (shared.entriesJson === EMPTY_JSON || !Array.isArray(v)) return v;
      shared.calls += 1;
      try {
        const lne = JSON.parse(shared.entriesJson);
        const taleIds = new Set();
        const systems = new Set();
        for (const incursion of v) {
          if (!incursion || typeof incursion !== "object") continue;
          const taleId = positiveId(incursion.taleID);
          if (taleId > 0) taleIds.add(taleId);
          for (const id of systemsOf(incursion)) systems.add(id);
        }
        const kept = [];
        let suppressed = 0;
        for (const entry of lne) {
          const clash = taleIds.has(positiveId(entry && entry.taleID))
            || systemsOf(entry || {}).some((id) => systems.has(id));
          if (clash) suppressed += 1;
          else kept.push(entry);
        }
        shared.lastSuppressed = suppressed;
        if (kept.length > 0) shared.merged += 1;
        return v.concat(kept);
      } catch (_err) {
        shared.errors += 1;
        return v;
      }
    };
    Object.defineProperty(wrapper, MARKER, { value: shared });
    return wrapper;
  }

  function ensureInstalled() {
    if (installed) return { ok: true };
    if (driftResult !== null) return driftResult;
    if (!requireGame) return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "no requireGame" };
    const loaded = requireGame(RUNTIME_PATH);
    if (!loaded || !loaded.ok || !loaded.exports) {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: fit((loaded && loaded.reason) || "") };
    }
    const srcDir = serverSrc();
    if (typeof srcDir !== "string" || srcDir === "") {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "server_src_unknown" };
    }
    const runtime = loaded.exports;
    const detail = fingerprintDetail(srcDir, runtime);
    if (detail !== null) {
      driftResult = Object.freeze({ ok: false, reason: "INCURSION_UI_DRIFT", detail: fit(detail) });
      return driftResult;
    }
    const current = runtime[EXPORT_NAME];
    if (current[MARKER] && typeof current[MARKER] === "object") {
      slot = current[MARKER];
    } else {
      runtime[EXPORT_NAME] = makeWrapper(current, slot);
    }
    installed = true;
    return { ok: true };
  }

  function publish(list) {
    if (!Array.isArray(list)) return { ok: false, reason: "INVALID_LIST" };
    try {
      const json = JSON.stringify(list);
      if (!installed && json === EMPTY_JSON) return { ok: true, count: 0 };
      const ready = ensureInstalled();
      if (!ready.ok) return ready;
      slot.entriesJson = json;
      if (json === EMPTY_JSON) slot.lastSuppressed = 0;
      return { ok: true, count: list.length };
    } catch (err) {
      return { ok: false, reason: "INCURSION_PUBLISH_FAILED", detail: fit((err && err.message) || err) };
    }
  }

  function stats() {
    return { installed, calls: slot.calls, merged: slot.merged, lastSuppressed: slot.lastSuppressed, errors: slot.errors };
  }

  return Object.freeze({ publish, stats });
}

module.exports = { RUNTIME_PATH, RUNTIME_SHA1, MARKER, createIncursionUiPublisher };
