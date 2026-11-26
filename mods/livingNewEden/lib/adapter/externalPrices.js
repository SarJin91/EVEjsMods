"use strict";

const { toMilli } = require("./marketPrices");

const FUZZWORK_HOST = "market.fuzzwork.co.uk";
const FUZZWORK_PATH = "/aggregates/";
const USER_AGENT = "LivingNewEden-EveJS-mod";
const MAX_TYPES = 192;
const EXT_REJECT_REASONS = Object.freeze(["MISSING", "NO_BID", "NO_ASK", "CROSSED", "TOO_HIGH"]);
const DETAIL_MAX = 200;

function isId(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function detailOf(x) {
  return String(x === undefined || x === null ? "" : x).slice(0, DETAIL_MAX);
}

function normalizeTypeIds(typeIds) {
  if (!Array.isArray(typeIds)) return null;
  const ids = [...new Set(typeIds.filter(isId))].sort((a, b) => a - b).slice(0, MAX_TYPES);
  return ids.length > 0 ? ids : null;
}

function aggregateMilli(side, field) {
  if (!isPlainObject(side)) return null;
  const milli = toMilli(Number(side[field]));
  return Number.isSafeInteger(milli) && milli > 0 ? milli : null;
}

function parseFuzzworkAggregates(body, typeIds, limits) {
  let root;
  try {
    root = JSON.parse(String(body));
  } catch (_err) {
    return { ok: false, reason: "EXT_BAD_JSON" };
  }
  if (!isPlainObject(root)) return { ok: false, reason: "EXT_BAD_SHAPE" };
  const ids = normalizeTypeIds(typeIds) || [];
  const maxMilli = limits && Number.isSafeInteger(limits.maxUnitPriceMilli) && limits.maxUnitPriceMilli > 0
    ? limits.maxUnitPriceMilli : 0;
  const prices = new Map();
  const rejected = new Map();
  for (const typeId of ids) {
    const entry = Object.prototype.hasOwnProperty.call(root, String(typeId)) ? root[String(typeId)] : null;
    if (!isPlainObject(entry)) { rejected.set(typeId, "MISSING"); continue; }
    const bidMilli = aggregateMilli(entry.buy, "percentile");
    if (bidMilli === null) { rejected.set(typeId, "NO_BID"); continue; }
    const askMilli = aggregateMilli(entry.sell, "percentile");
    if (askMilli === null) { rejected.set(typeId, "NO_ASK"); continue; }
    if (bidMilli > askMilli) { rejected.set(typeId, "CROSSED"); continue; }
    if (bidMilli > maxMilli || askMilli > maxMilli) { rejected.set(typeId, "TOO_HIGH"); continue; }
    prices.set(typeId, Object.freeze({ bidMilli, askMilli }));
  }
  return { ok: true, prices, rejected };
}

function createHttpsGetter(deps) {
  const https = deps && deps.https;
  const timeoutSignal = deps && typeof deps.timeoutSignal === "function"
    ? deps.timeoutSignal : (ms) => AbortSignal.timeout(ms);

  return function get(req) {
    return new Promise((resolve) => {
      let settled = false;
      let request = null;
      let timeout = null;
      const outer = req && req.signal ? req.signal : null;
      const cleanup = () => {
        if (timeout) timeout.removeEventListener("abort", onTimeout);
        if (outer) outer.removeEventListener("abort", onAbort);
      };
      const settle = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const destroy = () => {
        try { if (request && typeof request.destroy === "function") request.destroy(); } catch (_err) {}
      };
      const fail = (reason, detail) => {
        settle(detail === undefined ? { ok: false, reason } : { ok: false, reason, detail: detailOf(detail) });
      };
      function onTimeout() { fail("EXT_TIMEOUT"); destroy(); }
      function onAbort() { fail("EXT_ABORTED"); destroy(); }

      try {
        if (!https || typeof https.get !== "function") { fail("EXT_TRANSPORT", "no https"); return; }
        if (outer && outer.aborted) { fail("EXT_ABORTED"); return; }
        timeout = timeoutSignal(req.timeoutMs);
        timeout.addEventListener("abort", onTimeout);
        if (outer) outer.addEventListener("abort", onAbort);
        const maxBytes = req.maxBytes;
        request = https.get({
          hostname: req.hostname,
          path: req.path,
          method: "GET",
          headers: { accept: "application/json", "user-agent": USER_AGENT },
        }, (res) => {
          try {
            if (res.statusCode !== 200) {
              try { res.resume(); } catch (_err) {}
              fail("EXT_HTTP_STATUS", res.statusCode);
              destroy();
              return;
            }
            const chunks = [];
            let bytes = 0;
            res.on("data", (chunk) => {
              if (settled) return;
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
              bytes += buf.length;
              if (bytes > maxBytes) { fail("EXT_TOO_LARGE", bytes); destroy(); return; }
              chunks.push(buf);
            });
            res.on("end", () => settle({ ok: true, body: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", (err) => fail(outer && outer.aborted ? "EXT_ABORTED" : "EXT_TRANSPORT",
              (err && err.code) || (err && err.message) || err));
            res.on("aborted", () => fail("EXT_TRANSPORT", "aborted"));
          } catch (err) {
            fail("EXT_TRANSPORT", (err && err.message) || err);
            destroy();
          }
        });
        if (request && typeof request.on === "function") {
          request.on("error", (err) => fail(outer && outer.aborted ? "EXT_ABORTED" : "EXT_TRANSPORT",
            (err && err.code) || (err && err.message) || err));
        }
      } catch (err) {
        fail("EXT_TRANSPORT", (err && err.message) || err);
        destroy();
      }
    });
  };
}

async function fetchExternalPricesWith(getter, spec) {
  try {
    if (typeof getter !== "function" || !spec) return { ok: false, reason: "EXT_SPEC_INVALID" };
    const typeIds = normalizeTypeIds(spec.typeIds);
    if (!typeIds || !isId(spec.stationId)) return { ok: false, reason: "EXT_SPEC_INVALID" };
    if (!isId(spec.timeoutMs) || !isId(spec.maxResponseBytes)) return { ok: false, reason: "EXT_SPEC_INVALID" };
    const res = await getter({
      hostname: FUZZWORK_HOST,
      path: `${FUZZWORK_PATH}?station=${spec.stationId}&types=${typeIds.join(",")}`,
      timeoutMs: spec.timeoutMs,
      maxBytes: spec.maxResponseBytes,
      ...(spec.signal ? { signal: spec.signal } : {}),
    });
    if (!res || res.ok !== true) {
      const reason = res && typeof res.reason === "string" ? res.reason : "EXT_TRANSPORT";
      return res && res.detail !== undefined ? { ok: false, reason, detail: detailOf(res.detail) } : { ok: false, reason };
    }
    return parseFuzzworkAggregates(res.body, typeIds, { maxUnitPriceMilli: spec.maxUnitPriceMilli });
  } catch (err) {
    return { ok: false, reason: "EXT_THREW", detail: detailOf((err && err.message) || err) };
  }
}

function createDefaultHttpsGetter() {
  return createHttpsGetter({ https: require("node:https") });
}

module.exports = {
  FUZZWORK_HOST,
  FUZZWORK_PATH,
  MAX_TYPES,
  EXT_REJECT_REASONS,
  parseFuzzworkAggregates,
  createHttpsGetter,
  createDefaultHttpsGetter,
  fetchExternalPricesWith,
};
