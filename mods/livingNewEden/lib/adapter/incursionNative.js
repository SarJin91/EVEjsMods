"use strict";

const crypto = require("node:crypto");
const nodePath = require("node:path");
const { narrowCatalog } = require("./data/incursionSteer");
const { createIncursionTalesRead } = require("./incursionTalesRead");

const PLACEMENT_PATH = "services/incursion/incursionFocusPlacement";
const RUNTIME_FILE = "services/incursion/incursionFocusRuntime.js";
const CONTRACT_PATH = "services/incursion/incursionLifecycleContract";
const LIFECYCLE_PATH = "services/incursion/incursionLifecycle";
const REWARD_STORE_PATH = "services/incursion/incursionRewardStore";
const PLACEMENT_SHA1 = "b8f3afe90e96a306ff0d39296f1d9334b4dce978";
const RUNTIME_HOLDS_MODULE = ["const placement = require", "(\"./incursionFocusPlacement\")"].join("");
const RUNTIME_CALL = "placement.selectPlacement(geography, {";
const EXPORT_NAME = "selectPlacement";
const MARKER = Symbol.for("livingNewEden.incursionSteer");
const BANDS = Object.freeze(["high", "low", "null"]);
const MODES = Object.freeze(["steer", "exclusive"]);
const OUTCOMES = Object.freeze(["defeated", "expired"]);
const DEFAULT_LOG_SIZE = 16;
const MAX_LOG_SIZE = 64;
const MAX_TARGETS_PER_BAND = 256;
const RECEIPT_ID_RE = /^[A-Za-z0-9:_-]{1,180}$/;
const SELECTION_KEY_MAX = 128;
const DETAIL_MAX = 200;
const MAX_REWARD_PARTICIPANTS = 256;
const MAX_RECEIPTS = 512;

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

const messageOf = (err) => fit((err && err.message) || err);

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

const positiveId = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const timeOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

function viewOf(tale) {
  if (!tale || typeof tale !== "object") return null;
  const taleId = positiveId(tale.taleID);
  const placement = tale.placement && typeof tale.placement === "object" ? tale.placement : null;
  if (taleId === 0 || !placement) return null;
  const systemIds = [];
  for (const row of Array.isArray(placement.systems) ? placement.systems : []) {
    const id = positiveId(row && row.solarSystemID);
    if (id > 0) systemIds.push(id);
  }
  const key = placement.provenance && typeof placement.provenance.selectionKey === "string"
    && placement.provenance.selectionKey.length <= SELECTION_KEY_MAX ? placement.provenance.selectionKey : null;
  const t = tale.terminal && typeof tale.terminal === "object" ? tale.terminal : null;
  const terminal = t && OUTCOMES.includes(t.outcome) ? Object.freeze({ outcome: t.outcome,
    eventId: typeof t.eventID === "string" ? t.eventID : "", decidedAt: timeOf(t.decidedAtMs),
    bossReceiptId: typeof t.bossReceiptID === "string" && t.bossReceiptID !== "" ? t.bossReceiptID : null }) : null;
  return Object.freeze({ taleId, generation: positiveId(tale.generation), constellationId: positiveId(placement.constellationID),
    band: BANDS.includes(placement.securityBand) ? placement.securityBand : null, systemIds: Object.freeze(systemIds),
    selectionKey: key, createdAt: timeOf(tale.createdAtMs), expiresAt: timeOf(tale.expiresAtMs),
    phase: Number.isSafeInteger(tale.phase) ? tale.phase : 0,
    influence: tale.influence && Number.isFinite(tale.influence.value) ? tale.influence.value : 0, terminal });
}

function createIncursionNative(deps) {
  const requireGame = deps && typeof deps.requireGame === "function" ? deps.requireGame : null;
  const serverSrc = deps && typeof deps.serverSrc === "function" ? deps.serverSrc : () => null;
  const readFile = deps && typeof deps.readFile === "function" ? deps.readFile : () => null;
  const nowMs = deps && typeof deps.nowMs === "function" ? deps.nowMs : () => Date.now();

  let slot = { targets: null, mode: "steer", logSize: DEFAULT_LOG_SIZE, hits: 0, passthrough: 0, exclusiveNull: 0,
    errors: 0, steerLog: [], narrow: null, now: nowMs };
  let installed = false;
  let driftResult = null;
  const talesRead = createIncursionTalesRead({ requireGame });

  function load(rel) {
    if (!requireGame) return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "no requireGame" };
    try {
      const loaded = requireGame(rel);
      if (!loaded || !loaded.ok || !loaded.exports) {
        return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: fit((loaded && loaded.reason) || rel) };
      }
      return { ok: true, exports: loaded.exports };
    } catch (err) {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: messageOf(err) };
    }
  }

  function readText(srcDir, rel) {
    try {
      const text = readFile(nodePath.join(srcDir, ...rel.split("/")));
      return typeof text === "string" ? lf(text) : null;
    } catch (_err) {
      return null;
    }
  }

  function fingerprintDetail(srcDir, placement) {
    const placementText = readText(srcDir, `${PLACEMENT_PATH}.js`);
    if (placementText === null) return `${PLACEMENT_PATH}.js missing`;
    if (sha1(placementText) !== PLACEMENT_SHA1) return `${PLACEMENT_PATH}.js sha1`;
    const runtimeText = readText(srcDir, RUNTIME_FILE);
    if (runtimeText === null) return `${RUNTIME_FILE} missing`;
    if (runtimeText.split(RUNTIME_HOLDS_MODULE).length - 1 !== 1) return `${RUNTIME_FILE} module object`;
    if (runtimeText.split(RUNTIME_CALL).length - 1 !== 1) return `${RUNTIME_FILE} call site`;
    const current = placement[EXPORT_NAME];
    if (typeof current !== "function") return `${EXPORT_NAME} missing`;
    if (current[MARKER] && typeof current[MARKER] === "object") return null;
    if (lf(String(current)) !== functionBody(placementText, EXPORT_NAME)) return `${EXPORT_NAME} not the vendor function`;
    return null;
  }

  function makeWrapper(original, shared) {
    const wrapper = function lneSelectPlacement(...args) {
      const targets = shared.targets;
      const opts = args[1];
      const band = opts && typeof opts === "object" ? opts.securityBand : undefined;
      const list = targets && BANDS.includes(band) ? targets[band] : null;
      if (!list || list.length === 0) {
        shared.passthrough += 1;
        return original.apply(this, args);
      }
      let steered = null;
      let noMatch = false;
      try {
        const narrowed = shared.narrow(args[0], list, opts);
        if (!narrowed || narrowed.ok !== true) noMatch = true;
        else {
          const plan = original.call(this, narrowed.catalog, opts);
          const target = narrowed.target;
          if (plan && Array.isArray(plan.systems) && plan.systems.some((s) => s && s.solarSystemID === target.systemId)) {
            shared.steerLog.push({ selectionKey: typeof opts.selectionKey === "string" ? opts.selectionKey : "",
              systemId: target.systemId, constellationId: target.constellationId, atMs: shared.now() });
            while (shared.steerLog.length > shared.logSize) shared.steerLog.shift();
            shared.hits += 1;
            steered = plan;
          }
        }
      } catch (_err) {
        steered = null;
        noMatch = false;
      }
      if (steered) return steered;
      if (noMatch) {
        if (shared.mode === "exclusive") {
          shared.exclusiveNull += 1;
          return null;
        }
        shared.passthrough += 1;
        return original.apply(this, args);
      }
      shared.errors += 1;
      return original.apply(this, args);
    };
    Object.defineProperty(wrapper, MARKER, { value: shared });
    return wrapper;
  }

  function ensureInstalled() {
    if (installed) return { ok: true };
    if (driftResult !== null) return driftResult;
    const placement = load(PLACEMENT_PATH);
    if (!placement.ok) return placement;
    const contract = load(CONTRACT_PATH);
    if (!contract.ok) return contract;
    if (typeof contract.exports.fingerprint !== "function") {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "fingerprint missing" };
    }
    const srcDir = serverSrc();
    if (typeof srcDir !== "string" || srcDir === "") {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "server_src_unknown" };
    }
    const detail = fingerprintDetail(srcDir, placement.exports);
    if (detail !== null) {
      driftResult = Object.freeze({ ok: false, reason: "INCURSION_STEER_DRIFT", detail: fit(detail) });
      return driftResult;
    }
    const current = placement.exports[EXPORT_NAME];
    if (current[MARKER] && typeof current[MARKER] === "object") {
      slot = current[MARKER];
    } else {
      const fingerprint = contract.exports.fingerprint;
      slot.narrow = (catalog, list, opts) => narrowCatalog(catalog, list, opts,
        { fingerprint, affectedCount: catalog.policy.affectedSystemCount });
      placement.exports[EXPORT_NAME] = makeWrapper(current, slot);
    }
    installed = true;
    return { ok: true };
  }

  function normalizeTargets(byBand) {
    if (!byBand || typeof byBand !== "object" || Array.isArray(byBand)) return null;
    const out = {};
    for (const key of Object.keys(byBand)) {
      if (!BANDS.includes(key)) return null;
      const list = byBand[key];
      if (!Array.isArray(list) || list.length > MAX_TARGETS_PER_BAND) return null;
      const rows = [];
      for (const t of list) {
        const id = positiveId(t && t.systemId);
        if (id === 0) return null;
        rows.push(Object.freeze({ systemId: id }));
      }
      out[key] = Object.freeze(rows);
    }
    return Object.freeze(out);
  }

  function setSteerTargets(byBand, mode, logSize) {
    try {
      if (byBand === null) {
        if (installed) slot.targets = null;
        return { ok: true, installed };
      }
      const targets = normalizeTargets(byBand);
      if (targets === null || !MODES.includes(mode)) return { ok: false, reason: "INVALID_TARGETS" };
      const ready = ensureInstalled();
      if (!ready.ok) return ready;
      if (Number.isSafeInteger(logSize) && logSize >= 1) slot.logSize = Math.min(logSize, MAX_LOG_SIZE);
      slot.mode = mode;
      slot.targets = targets;
      return { ok: true, installed };
    } catch (err) {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: messageOf(err) };
    }
  }

  function listTales(req) {
    try {
      const limit = req && Number.isSafeInteger(req.limit) && req.limit > 0 ? req.limit : 0;
      if (limit === 0) return { ok: false, reason: "INCURSION_READ_FAILED", detail: "limit" };
      const sinceMs = req && Number.isSafeInteger(req.sinceMs) ? req.sinceMs : 0;
      const lifecycle = load(LIFECYCLE_PATH);
      if (!lifecycle.ok) return lifecycle;
      if (typeof lifecycle.exports.listTales !== "function") {
        return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "listTales missing" };
      }
      const read = talesRead.read(lifecycle.exports);
      if (!read.ok) return { ok: false, reason: "INCURSION_READ_FAILED", detail: read.detail };
      const raw = read.tales;
      const views = [];
      for (const tale of raw) {
        const v = viewOf(tale);
        if (v && (v.terminal === null || v.createdAt >= sinceMs)) views.push(v);
      }
      views.sort((a, b) => b.taleId - a.taleId);
      const truncated = views.length > limit;
      return { ok: true, tales: truncated ? views.slice(0, limit) : views, truncated };
    } catch (err) {
      return { ok: false, reason: "INCURSION_READ_FAILED", detail: messageOf(err) };
    }
  }

  function bossParticipants(receiptId, limit) {
    try {
      if (typeof receiptId !== "string" || !RECEIPT_ID_RE.test(receiptId)) {
        return { ok: false, reason: "INCURSION_READ_FAILED", detail: "receiptId" };
      }
      const max = Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
      const store = load(REWARD_STORE_PATH);
      if (!store.ok) return store;
      if (typeof store.exports.read !== "function") {
        return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "read missing" };
      }
      let receipt;
      try {
        receipt = store.exports.read(`/receipts/${receiptId}`);
      } catch (err) {
        return { ok: false, reason: "INCURSION_READ_FAILED", detail: messageOf(err) };
      }
      const rows = receipt && Array.isArray(receipt.participants) ? receipt.participants : [];
      const list = [];
      for (const p of rows) {
        const id = positiveId(p && p.characterID);
        if (id > 0) list.push({ id, lp: p && Number.isFinite(p.netLP) ? p.netLP : 0 });
      }
      list.sort((a, b) => b.lp - a.lp || a.id - b.id);
      return { ok: true, characterIds: list.slice(0, max).map((p) => p.id) };
    } catch (err) {
      return { ok: false, reason: "INCURSION_READ_FAILED", detail: messageOf(err) };
    }
  }

  function participants(taleId, limit, maxReceipts) {
    try {
      if (positiveId(taleId) !== taleId) return { ok: false, reason: "INCURSION_READ_FAILED", detail: "taleId" };
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REWARD_PARTICIPANTS) {
        return { ok: false, reason: "INCURSION_READ_FAILED", detail: "limit" };
      }
      if (!Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > MAX_RECEIPTS) {
        return { ok: false, reason: "INCURSION_READ_FAILED", detail: "maxReceipts" };
      }
      const lifecycle = load(LIFECYCLE_PATH);
      if (!lifecycle.ok) return lifecycle;
      if (typeof lifecycle.exports.getTale !== "function") {
        return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "getTale missing" };
      }
      let tale;
      try {
        tale = lifecycle.exports.getTale(taleId);
      } catch (err) {
        return { ok: false, reason: "INCURSION_READ_FAILED", detail: messageOf(err) };
      }
      if (!tale || typeof tale !== "object") return { ok: false, reason: "TALE_NOT_FOUND" };
      const terminal = tale.terminal && typeof tale.terminal === "object" ? tale.terminal : null;
      if (!terminal || terminal.outcome !== "defeated") return { ok: false, reason: "NOT_DEFEATED" };
      const ids = [];
      for (const r of Array.isArray(terminal.receipts) ? terminal.receipts : []) {
        const id = r && typeof r.receiptID === "string" ? r.receiptID : null;
        if (id !== null && RECEIPT_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
      }
      let truncated = ids.length > maxReceipts;
      const store = load(REWARD_STORE_PATH);
      if (!store.ok) return store;
      if (typeof store.exports.read !== "function") {
        return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "read missing" };
      }
      const sums = new Map();
      let receipts = 0;
      for (const id of ids.slice(0, maxReceipts)) {
        let receipt;
        try {
          receipt = store.exports.read(`/receipts/${id}`);
        } catch (err) {
          return { ok: false, reason: "INCURSION_READ_FAILED", detail: messageOf(err) };
        }
        if (!receipt || typeof receipt !== "object") continue;
        receipts += 1;
        for (const p of Array.isArray(receipt.participants) ? receipt.participants : []) {
          const cid = positiveId(p && p.characterID);
          if (cid === 0) continue;
          const lp = p && Number.isFinite(p.netLP) ? p.netLP : 0;
          sums.set(cid, (sums.get(cid) || 0) + lp);
        }
      }
      const list = [...sums].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      if (list.length > limit) truncated = true;
      return { ok: true, characterIds: list.slice(0, limit).map(([id]) => id), truncated, receipts };
    } catch (err) {
      return { ok: false, reason: "INCURSION_READ_FAILED", detail: messageOf(err) };
    }
  }

  function vendorBands() {
    try {
      const contract = load(CONTRACT_PATH);
      if (!contract.ok) return contract;
      const fn = contract.exports.organicSchedulingEnabled;
      if (typeof fn !== "function") {
        return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "organicSchedulingEnabled missing" };
      }
      const bands = {};
      for (const band of BANDS) bands[band] = fn(band) === true;
      return { ok: true, bands: Object.freeze(bands) };
    } catch (err) {
      return { ok: false, reason: "INCURSION_READ_FAILED", detail: messageOf(err) };
    }
  }

  function stats() {
    return { installed, drift: driftResult !== null, hits: slot.hits, passthrough: slot.passthrough,
      exclusiveNull: slot.exclusiveNull, errors: slot.errors, steerLog: slot.steerLog.map((e) => ({ ...e })) };
  }

  return Object.freeze({ setSteerTargets, listTales, bossParticipants, participants, vendorBands, stats });
}

module.exports = { PLACEMENT_PATH, PLACEMENT_SHA1, MARKER, createIncursionNative, viewOf, MAX_REWARD_PARTICIPANTS,
  MAX_RECEIPTS };
