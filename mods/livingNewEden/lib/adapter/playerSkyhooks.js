"use strict";

const { performance } = require("node:perf_hooks");

const PATHS = Object.freeze({
  sov: "services/sovereignty/sovModernState",
});

const REQUIRED = Object.freeze({
  sov: Object.freeze(["listRaidSkyhooks"]),
});

const RAID_PATHS = Object.freeze({
  sov: "services/sovereignty/sovModernState",
  harvest: "services/sovereignty/skyhookHarvest",
  rules: "services/sovereignty/skyhookRaidRules",
  types: "services/inventory/itemTypeRegistry",
});

const RAID_REQUIRED = Object.freeze({
  sov: Object.freeze(["listRaidSkyhooks", "getRaidSkyhook", "mutateSkyhookRaid"]),
  harvest: Object.freeze(["settleSkyhookHarvest"]),
  rules: Object.freeze(["isWindowOpen"]),
  types: Object.freeze(["resolveItemByTypeID"]),
});

const REASONS = Object.freeze({
  UNAVAILABLE: "PLAYER_SKYHOOKS_SEAM_UNAVAILABLE",
  RAID_UNAVAILABLE: "HARVEST_RAID_SKYHOOK_SEAM_UNAVAILABLE",
  SEAM_ERROR: "SEAM_ERROR",
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND: "SKYHOOK_NOT_FOUND",
  BUSY: "SKYHOOK_BUSY",
  RAID_STATE_MISSING: "SKYHOOK_RAID_STATE_MISSING",
  RAID_CLOSED: "SKYHOOK_RAID_CLOSED",
  NOT_DURABLE: "SKYHOOK_RAID_NOT_DURABLE",
  GENERATION_CHANGED: "SKYHOOK_GENERATION_CHANGED",
  WINDOW_CLOSED: "SKYHOOK_WINDOW_CLOSED",
  RECORD_SHAPE: "SKYHOOK_RECORD_SHAPE",
});

const STEAL_CODES = Object.freeze([REASONS.NOT_FOUND, REASONS.BUSY, REASONS.RAID_STATE_MISSING, REASONS.RAID_CLOSED,
  REASONS.NOT_DURABLE, REASONS.GENERATION_CHANGED, REASONS.WINDOW_CLOSED, REASONS.RECORD_SHAPE]);
const PERMANENT = Object.freeze([REASONS.NOT_FOUND, REASONS.RAID_CLOSED, REASONS.GENERATION_CHANGED,
  REASONS.WINDOW_CLOSED, REASONS.RECORD_SHAPE, REASONS.INVALID_INPUT]);

const CONSUMER = "playerValue";
const RAID_CONSUMER = "harvestRaidSkyhook";
const MAX_DETAIL = 120;
const MAX_ID_LENGTH = 64;
const MAX_THEFT_IDS = 8;
const MAX_STEAL_LINES = 128;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isKey = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const refuse = (reason, detail) => (detail === undefined ? { ok: false, reason } : { ok: false, reason, detail });
const unavailable = (detail) => refuse(REASONS.UNAVAILABLE, detail);
const raidUnavailable = (detail) => refuse(REASONS.RAID_UNAVAILABLE, detail);

function checkSet(vendor, paths, required, fail) {
  try {
    if (!vendor || typeof vendor !== "object") return fail("vendor");
    for (const key of Object.keys(paths)) {
      const mod = vendor[key];
      if (!mod || typeof mod !== "object") return fail(paths[key]);
      for (const name of required[key]) if (typeof mod[name] !== "function") return fail(`${paths[key]}.${name}`);
    }
    return { ok: true };
  } catch (err) {
    return fail(detailOf(err));
  }
}

function checkSeamsFrom(vendor) {
  return checkSet(vendor, PATHS, REQUIRED, unavailable);
}

function checkRaidSeamsFrom(vendor) {
  return checkSet(vendor, RAID_PATHS, RAID_REQUIRED, raidUnavailable);
}

function listPlayerSkyhooksFrom(vendor, opts) {
  const max = opts && opts.max;
  if (!Number.isSafeInteger(max) || max < 0) return refuse(REASONS.INVALID_INPUT, "max");
  if (max === 0) return { ok: true, skyhooks: [], truncated: false };
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const records = vendor.sov.listRaidSkyhooks();
    const out = [];
    for (const r of Array.isArray(records) ? records : []) {
      if (!r || typeof r !== "object") continue;
      const skyhookId = Number(r.skyhookID);
      const systemId = Number(r.solarSystemID);
      const corpId = Number(r.corporationID);
      if (!isId(skyhookId) || !isId(systemId) || !isId(corpId)) continue;
      out.push(Object.freeze({ skyhookId, systemId, corpId, active: r.active !== false,
        destroyed: r.destroyed === true }));
    }
    out.sort((a, b) => a.skyhookId - b.skyhookId);
    const truncated = out.length > max;
    return { ok: true, skyhooks: truncated ? out.slice(0, max) : out, truncated };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function takenOf(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((t) => isPlain(t) && isId(t.typeId) && isId(t.units))
    .map((t) => ({ typeId: t.typeId, units: t.units }));
}

function theftOf(raid) {
  const theft = raid && isPlain(raid.lneTheft) ? raid.lneTheft : null;
  const ids = theft && Array.isArray(theft.ids) ? theft.ids.filter(isKey) : [];
  const last = theft && isPlain(theft.last) && isKey(theft.last.raidId) ? theft.last : null;
  return { ids, last };
}

function unitVolumeOf(vendor, typeId) {
  const meta = vendor.types.resolveItemByTypeID(typeId);
  const volume = meta && typeof meta === "object" ? Number(meta.volume) : NaN;
  return Number.isFinite(volume) && volume >= 0 ? volume : 0;
}

function readSkyhookFrom(vendor, skyhookId, opts) {
  if (!isId(skyhookId)) return refuse(REASONS.INVALID_INPUT, "skyhookId");
  const nowMs = opts && opts.nowMs;
  if (!isTime(nowMs)) return refuse(REASONS.INVALID_INPUT, "nowMs");
  const check = checkRaidSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const rec = vendor.sov.getRaidSkyhook(skyhookId);
    if (!rec || typeof rec !== "object") return refuse(REASONS.NOT_FOUND);
    vendor.harvest.settleSkyhookHarvest(rec);
    const tv = isPlain(rec.theftVulnerability) ? rec.theftVulnerability : {};
    const window = { startMs: isTime(tv.startMs) ? tv.startMs : 0, endMs: isTime(tv.endMs) ? tv.endMs : 0 };
    const raid = isPlain(rec.raid) ? rec.raid : null;
    const raidState = raid === null ? "missing" : raid.closed === true ? "closed" : "ready";
    const byType = new Map();
    for (const sim of Array.isArray(rec.reagentSimulations) ? rec.reagentSimulations : []) {
      if (!isPlain(sim) || !isId(sim.reagentTypeID) || byType.has(sim.reagentTypeID)) continue;
      if (!Number.isSafeInteger(sim.unsecuredStock) || sim.unsecuredStock <= 0) continue;
      byType.set(sim.reagentTypeID, sim.unsecuredStock);
    }
    const unsecured = [...byType.keys()].sort((a, b) => a - b).map((typeId) => ({ typeId, units: byType.get(typeId),
      unitVolume: unitVolumeOf(vendor, typeId) }));
    return { ok: true, skyhook: { skyhookId, systemId: Number(rec.solarSystemID), corpId: Number(rec.corporationID),
      active: rec.active === true, destroyed: rec.destroyed === true, window,
      windowOpen: Boolean(vendor.rules.isWindowOpen(rec, nowMs)), raidState,
      generation: raid && isKey(raid.generation) ? raid.generation : null,
      busy: Boolean(raid && (raid.pendingSettlement || raid.activeLink)), unsecured } };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function readSkyhookTheftFrom(vendor, spec) {
  if (!spec || !isId(spec.skyhookId) || !isKey(spec.raidId)) return refuse(REASONS.INVALID_INPUT, "spec");
  const check = checkRaidSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const rec = vendor.sov.getRaidSkyhook(spec.skyhookId);
    if (!rec || typeof rec !== "object") return refuse(REASONS.NOT_FOUND);
    const { ids, last } = theftOf(isPlain(rec.raid) ? rec.raid : null);
    const found = ids.includes(spec.raidId);
    return { ok: true, found, taken: found && last && last.raidId === spec.raidId ? takenOf(last.taken) : null };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function stealSpecOf(spec) {
  if (!spec || !isId(spec.skyhookId) || !isKey(spec.raidId) || !isKey(spec.generation) || !isTime(spec.nowMs)
    || !Array.isArray(spec.lines) || spec.lines.length > MAX_STEAL_LINES) return null;
  if (!spec.lines.every((l) => isPlain(l) && isId(l.typeId) && isId(l.units))) return null;
  const seen = new Set();
  const lines = [];
  for (const l of [...spec.lines].sort((a, b) => a.typeId - b.typeId)) {
    if (seen.has(l.typeId)) continue;
    seen.add(l.typeId);
    lines.push({ typeId: l.typeId, units: l.units });
  }
  return { skyhookId: spec.skyhookId, raidId: spec.raidId, generation: spec.generation, nowMs: spec.nowMs, lines };
}

const stealRefusal = (reason, writeMs, detail) => ({ ok: false, reason, permanent: PERMANENT.includes(reason),
  ...(writeMs === undefined ? {} : { writeMs }), ...(detail === undefined ? {} : { detail }) });

function stealSkyhookReagentsFrom(vendor, spec, opts) {
  const s = stealSpecOf(spec);
  if (!s) return stealRefusal(REASONS.INVALID_INPUT, undefined, "spec");
  const check = checkRaidSeamsFrom(vendor);
  if (!check.ok) return stealRefusal(check.reason, undefined, check.detail);
  const clock = opts && typeof opts.now === "function" ? opts.now : () => performance.now();
  const t0 = clock();
  let result;
  try {
    result = vendor.sov.mutateSkyhookRaid(s.skyhookId, (rec) => {
      const raid = isPlain(rec.raid) ? rec.raid : null;
      if (!raid) throw new Error(REASONS.RAID_STATE_MISSING);
      if (raid.closed === true) throw new Error(REASONS.RAID_CLOSED);
      const { ids, last } = theftOf(raid);
      if (ids.includes(s.raidId)) {
        return { duplicate: true, taken: last && last.raidId === s.raidId ? takenOf(last.taken) : [] };
      }
      if (raid.pendingSettlement || raid.activeLink) throw new Error(REASONS.BUSY);
      if (raid.generation !== s.generation) throw new Error(REASONS.GENERATION_CHANGED);
      if (!vendor.rules.isWindowOpen(rec, s.nowMs)) throw new Error(REASONS.WINDOW_CLOSED);
      if (typeof rec.active !== "boolean" || !Array.isArray(rec.reagentSimulations)) {
        throw new Error(REASONS.RECORD_SHAPE);
      }
      vendor.harvest.settleSkyhookHarvest(rec);
      const taken = [];
      for (const line of s.lines) {
        const sim = rec.reagentSimulations.find((x) => isPlain(x) && x.reagentTypeID === line.typeId);
        const stock = sim && Number.isSafeInteger(sim.unsecuredStock) ? sim.unsecuredStock : 0;
        const take = Math.min(line.units, stock);
        if (!(take > 0)) continue;
        sim.unsecuredStock = stock - take;
        taken.push({ typeId: line.typeId, units: take });
      }
      raid.lneTheft = { ids: [...ids, s.raidId].slice(-MAX_THEFT_IDS), last: { raidId: s.raidId,
        taken: taken.map((t) => ({ ...t })) } };
      return { duplicate: false, taken };
    });
  } catch (err) {
    const msg = String((err && err.message) || err);
    const writeMs = Math.max(0, clock() - t0);
    return STEAL_CODES.includes(msg) ? stealRefusal(msg, writeMs)
      : stealRefusal(REASONS.SEAM_ERROR, writeMs, msg.slice(0, MAX_DETAIL));
  }
  const writeMs = Math.max(0, clock() - t0);
  if (!isPlain(result)) return stealRefusal(REASONS.SEAM_ERROR, writeMs, "no result");
  return { ok: true, duplicate: result.duplicate === true, taken: takenOf(result.taken), writeMs };
}

function createPlayerSkyhookSeam(deps) {
  const lazySet = (paths, consumer, fail) => {
    let vendor = null;
    const load = () => {
      let off = null;
      try {
        off = deps && typeof deps.disabledReason === "function" ? deps.disabledReason(consumer) : null;
      } catch (err) {
        off = detailOf(err);
      }
      if (off) return fail(String(off).slice(0, MAX_DETAIL));
      if (vendor !== null) return { ok: true, vendor };
      const requireGame = deps && deps.requireGame;
      if (typeof requireGame !== "function") return fail("requireGame");
      const loaded = {};
      for (const key of Object.keys(paths)) {
        let r;
        try {
          r = requireGame(paths[key]);
        } catch (err) {
          return fail(`${paths[key]}: ${detailOf(err)}`.slice(0, MAX_DETAIL));
        }
        if (!r || r.ok !== true || !r.exports || typeof r.exports !== "object") {
          return fail(`${paths[key]}: ${String((r && r.reason) || "not loaded")}`.slice(0, MAX_DETAIL));
        }
        loaded[key] = r.exports;
      }
      vendor = Object.freeze(loaded);
      return { ok: true, vendor };
    };
    return (fn) => (...args) => {
      const l = load();
      return l.ok ? fn(l.vendor, ...args) : l;
    };
  };

  const withVendor = lazySet(PATHS, CONSUMER, unavailable);
  const withRaid = lazySet(RAID_PATHS, RAID_CONSUMER, raidUnavailable);
  const stealUnavailable = (r) => (r.ok === false && r.permanent === undefined ? stealRefusal(r.reason, undefined,
    r.detail) : r);

  return Object.freeze({
    checkSeams: withVendor((v) => checkSeamsFrom(v)),
    listPlayerSkyhooks: withVendor((v, opts) => listPlayerSkyhooksFrom(v, opts)),
    checkRaidSeams: withRaid((v) => checkRaidSeamsFrom(v)),
    readSkyhook: withRaid((v, skyhookId, opts) => readSkyhookFrom(v, skyhookId, opts)),
    readSkyhookTheft: withRaid((v, spec) => readSkyhookTheftFrom(v, spec)),
    stealSkyhookReagents: (spec) => stealUnavailable(withRaid((v, s) => stealSkyhookReagentsFrom(v, s))(spec)),
  });
}

const SEAM_METHODS = Object.freeze(["checkSeams", "listPlayerSkyhooks", "checkRaidSeams", "readSkyhook",
  "readSkyhookTheft", "stealSkyhookReagents"]);

module.exports = { PATHS, REQUIRED, RAID_PATHS, RAID_REQUIRED, REASONS, CONSUMER, RAID_CONSUMER, MAX_THEFT_IDS,
  SEAM_METHODS, checkSeamsFrom, checkRaidSeamsFrom, listPlayerSkyhooksFrom, readSkyhookFrom, readSkyhookTheftFrom,
  stealSkyhookReagentsFrom, createPlayerSkyhookSeam };
