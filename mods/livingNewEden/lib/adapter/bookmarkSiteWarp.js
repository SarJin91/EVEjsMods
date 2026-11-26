"use strict";

const PATHS = Object.freeze({
  bookmark: "services/bookmark/bookmarkRuntimeState",
  dungeonSites: "services/dungeon/dungeonUniverseSiteService",
  runtime: "space/runtime",
});
const METHOD_NAME = "Handle_CmdWarpToStuff";
const WARP_MARK = Symbol.for("livingNewEden.bookmarkSiteWarp");
const UNAVAILABLE = "BOOKMARK_SITE_WARP_UNAVAILABLE";

const COUNTER_NAMES = Object.freeze(["bookmarkWarps", "materialized", "refused", "noSite", "skipped",
  "unavailable", "failed", "inWarp"]);

const toPositiveInt = (v) => {
  const n = typeof v === "bigint" || (typeof v === "string" && v.trim() !== "") ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

const errorText = (err) => String((err && err.message) || err).slice(0, 200);

function safeCall(fn, ...args) {
  try {
    if (typeof fn === "function") return fn(...args);
  } catch (_err) {
  }
  return undefined;
}

function pointOf(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function findNearestUniverseSite(scene, point, rangeMeters) {
  const anchor = pointOf(point);
  const range = Number(rangeMeters);
  if (!scene || !Array.isArray(scene.staticEntities) || anchor === null || !Number.isFinite(range) || range < 0) {
    return null;
  }
  const rangeSquared = range * range;
  let nearest = null;
  let nearestSquared = Number.POSITIVE_INFINITY;
  for (const entity of scene.staticEntities) {
    if (!entity || entity.signalTrackerUniverseSeededSite !== true) continue;
    const at = pointOf(entity.position);
    if (at === null) continue;
    const dx = at.x - anchor.x;
    const dy = at.y - anchor.y;
    const dz = at.z - anchor.z;
    const squared = dx * dx + dy * dy + dz * dz;
    if (squared > rangeSquared || squared >= nearestSquared) continue;
    nearest = entity;
    nearestSquared = squared;
  }
  return nearest;
}

function afterBookmarkWarp(args, session, deps) {
  const d = deps || {};
  const skip = () => {
    safeCall(d.count, "skipped");
    return { ok: false, reason: "SKIPPED" };
  };
  try {
    const list = Array.isArray(args) ? args : [];
    const bookmarkID = toPositiveInt(list[1]);
    const warpType = list[0] === undefined || list[0] === null ? "" : String(list[0]);
    if (safeCall(d.isEnabled) !== true || warpType !== "bookmark" || bookmarkID === 0) return skip();
    safeCall(d.count, "bookmarkWarps");
    const got = d.toolsOf();
    if (!got || got.ok !== true || !got.tools) {
      safeCall(d.count, "unavailable");
      return { ok: false, reason: "UNAVAILABLE" };
    }
    const tools = got.tools;
    const view = tools.getBookmarkForCharacter(session && session.characterID, bookmarkID, { requireActive: true });
    const bm = view ? view.bookmark || view : null;
    if (!bm) return skip();
    const metadata = bm.metadata && typeof bm.metadata === "object" ? bm.metadata : {};
    if (toPositiveInt(bm.itemID) !== 0 || toPositiveInt(metadata.missionInstanceID) !== 0) return skip();
    const scene = tools.getSceneForSession(session);
    if (!scene) return skip();
    const systemId = toPositiveInt(scene.systemID);
    const locationId = toPositiveInt(bm.locationID);
    if (locationId !== 0 && locationId !== systemId) return skip();
    const site = findNearestUniverseSite(scene, { x: bm.x, y: bm.y, z: bm.z }, d.rangeMetersOf());
    const siteId = toPositiveInt(site && site.itemID);
    if (siteId === 0) {
      safeCall(d.count, "noSite");
      return { ok: false, reason: "NO_SITE" };
    }
    const r = tools.ensureSiteContentsMaterialized(scene, { siteID: siteId },
      { spawnEncounters: true, broadcast: true, session });
    if (r && r.success === true) {
      const data = r.data || {};
      const summary = data.contentSummary || {};
      safeCall(d.count, "materialized");
      safeCall(d.logLine, `bookmarkSiteWarp: materialized site=${siteId} system=${systemId} `
        + `rocks=${summary.miningRocksSpawned === undefined ? "?" : summary.miningRocksSpawned} `
        + `rockEntities=${data.miningRockEntityCount === undefined ? "?" : data.miningRockEntityCount} `
        + `already=${data.alreadyMaterialized === true}`);
      return { ok: true, siteId };
    }
    safeCall(d.count, "refused");
    safeCall(d.logLine, `bookmarkSiteWarp: refused site=${siteId} system=${systemId} - `
      + `${(r && typeof r.errorMsg === "string" && r.errorMsg !== "" ? r.errorMsg : "NO_RESULT").slice(0, 80)}`);
    return { ok: false, reason: "REFUSED" };
  } catch (err) {
    safeCall(d.count, "failed");
    safeCall(d.logLine, `bookmarkSiteWarp: error - ${errorText(err)}`);
    return { ok: false, reason: "FAILED" };
  }
}

function shipAlreadyInWarp(args, session, d) {
  try {
    const list = Array.isArray(args) ? args : [];
    if (safeCall(d.isEnabled) !== true || list[0] !== "bookmark") return false;
    const got = typeof d.toolsOf === "function" ? d.toolsOf() : null;
    if (!got || got.ok !== true || !got.tools || typeof got.tools.isSessionShipWarping !== "function") return false;
    return got.tools.isSessionShipWarping(session) === true;
  } catch (_err) {
    return false;
  }
}

function wrapWarpForBookmarkSites(original, deps) {
  const d = deps || {};
  const wrapped = function livingNewEdenBookmarkSiteWarp(args, session) {
    if (shipAlreadyInWarp(args, session, d)) {
      safeCall(d.count, "inWarp");
      return original.apply(this, arguments);
    }
    const result = original.apply(this, arguments);
    if (safeCall(d.isEnabled) === true) {
      try {
        afterBookmarkWarp(args, session, d);
      } catch (_err) {
      }
    }
    return result;
  };
  Object.defineProperty(wrapped, WARP_MARK, { value: true });
  return wrapped;
}

function createBookmarkSiteWarpTools(deps) {
  const load = (key) => {
    const r = deps.requireGame(PATHS[key]);
    return r && r.ok === true && r.exports ? r.exports : null;
  };
  const has = (obj, name) => Boolean(obj) && typeof obj[name] === "function";

  function get() {
    const off = typeof deps.disabledReason === "function" ? deps.disabledReason() : null;
    if (off !== null && off !== undefined) return { ok: false, reason: UNAVAILABLE, detail: String(off) };
    const bookmark = load("bookmark");
    const sites = load("dungeonSites");
    const runtime = load("runtime");
    const missing = [];
    if (!has(bookmark, "getBookmarkForCharacter")) missing.push("getBookmarkForCharacter");
    if (!has(sites, "ensureSiteContentsMaterialized")) missing.push("ensureSiteContentsMaterialized");
    if (!has(runtime, "getSceneForSession")) missing.push("getSceneForSession");
    if (missing.length > 0) return { ok: false, reason: UNAVAILABLE, detail: missing.join(",") };
    const tools = Object.freeze({
      getBookmarkForCharacter: (characterID, bookmarkID, options) =>
        bookmark.getBookmarkForCharacter(characterID, bookmarkID, options),
      getSceneForSession: (session) => runtime.getSceneForSession(session),
      isSessionShipWarping: (session) => {
        const scene = runtime.getSceneForSession(session);
        const entity = scene && typeof scene.getShipEntityForSession === "function"
          ? scene.getShipEntityForSession(session) : null;
        return Boolean(entity && entity.mode === "WARP");
      },
      ensureSiteContentsMaterialized: (scene, instanceOrSite, options) =>
        sites.ensureSiteContentsMaterialized(scene, instanceOrSite, options),
    });
    return { ok: true, tools };
  }

  return Object.freeze({ get });
}

function installBookmarkSiteWarp(serviceClass, makeWrapper) {
  try {
    const proto = serviceClass && serviceClass.prototype;
    if (!proto || typeof proto[METHOD_NAME] !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
    if (proto[METHOD_NAME][WARP_MARK] === true) return { ok: true, alreadyInstalled: true };
    const desc = Object.getOwnPropertyDescriptor(proto, METHOD_NAME);
    if (Object.isFrozen(proto) || !desc || (!desc.writable && typeof desc.set !== "function")) {
      return { ok: false, reason: "NOT_WRITABLE" };
    }
    const wrapped = makeWrapper(proto[METHOD_NAME]);
    if (typeof wrapped !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
    proto[METHOD_NAME] = wrapped;
    return { ok: true, alreadyInstalled: false };
  } catch (_err) {
    return { ok: false, reason: "NOT_WRITABLE" };
  }
}

module.exports = {
  PATHS,
  METHOD_NAME,
  COUNTER_NAMES,
  wrapWarpForBookmarkSites,
  afterBookmarkWarp,
  findNearestUniverseSite,
  createBookmarkSiteWarpTools,
  installBookmarkSiteWarp,
};
