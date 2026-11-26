"use strict";

const USER_AGENT = "LivingNewEden-chatterAi";
const CODE_RE = /^[A-Z0-9_]{1,40}$/;
const RETRY_AFTER_RE = /^\d{1,6}$/;
const MAX_RETRY_AFTER_S = 86400;
const MS_PER_S = 1000;

function codeOf(err) {
  const code = err && err.code;
  return typeof code === "string" && CODE_RE.test(code) ? code : null;
}

function retryAfterMsOf(res) {
  const headers = res && res.headers && typeof res.headers === "object" ? res.headers : null;
  const raw = headers ? headers["retry-after"] : undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!RETRY_AFTER_RE.test(text)) return null;
  const s = Number(text);
  return s <= MAX_RETRY_AFTER_S ? s * MS_PER_S : null;
}

function declaredLength(res) {
  const raw = res && res.headers && typeof res.headers === "object" ? res.headers["content-length"] : undefined;
  const n = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

function createChatTransport(deps) {
  const request = deps && deps.request;
  const timeoutSignal = deps && typeof deps.timeoutSignal === "function"
    ? deps.timeoutSignal : (ms) => AbortSignal.timeout(ms);

  function post(spec) {
    return new Promise((resolve) => {
      let settled = false;
      let req = null;
      let timeout = null;
      const outer = spec && spec.signal ? spec.signal : null;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        try { if (timeout) timeout.removeEventListener("abort", onTimeout); } catch (_err) {}
        try { if (outer) outer.removeEventListener("abort", onAbort); } catch (_err) {}
        resolve(value);
      };
      const destroy = () => {
        try { if (req && typeof req.destroy === "function") req.destroy(); } catch (_err) {}
      };
      const netError = (err) => {
        if (outer && outer.aborted) { settle({ ok: false, reason: "ABORTED" }); return; }
        const code = codeOf(err);
        settle(code ? { ok: false, reason: "NET_ERROR", code } : { ok: false, reason: "NET_ERROR" });
      };
      function onTimeout() { settle({ ok: false, reason: "TIMEOUT" }); destroy(); }
      function onAbort() { settle({ ok: false, reason: "ABORTED" }); destroy(); }
      const onResponse = (res) => {
        try {
          const status = res && Number.isInteger(res.statusCode) ? res.statusCode : 0;
          if (status < 200 || status >= 300) {
            try { res.resume(); } catch (_err) {}
            settle({ ok: false, reason: "HTTP_STATUS", status, retryAfterMs: retryAfterMsOf(res) });
            return;
          }
          const maxBytes = spec.maxBytes;
          const declared = declaredLength(res);
          if (declared !== null && declared > maxBytes) {
            settle({ ok: false, reason: "TOO_LARGE" });
            destroy();
            return;
          }
          const chunks = [];
          let bytes = 0;
          res.on("data", (chunk) => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
            bytes += buf.length;
            if (bytes > maxBytes) {
              settle({ ok: false, reason: "TOO_LARGE" });
              destroy();
              return;
            }
            chunks.push(buf);
          });
          res.on("end", () => {
            if (settled) return;
            let json;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch (_err) {
              settle({ ok: false, reason: "BAD_JSON" });
              return;
            }
            if (!json || typeof json !== "object" || Array.isArray(json)) settle({ ok: false, reason: "BAD_JSON" });
            else settle({ ok: true, status, json });
          });
          res.on("error", netError);
          res.on("aborted", () => netError(null));
        } catch (err) {
          netError(err);
          destroy();
        }
      };

      try {
        if (typeof request !== "function" || !spec || !(spec.url instanceof URL) || typeof spec.apiKey !== "string"
          || !Number.isSafeInteger(spec.maxBytes) || spec.maxBytes <= 0) {
          settle({ ok: false, reason: "NET_ERROR" });
          return;
        }
        if (outer && outer.aborted) { settle({ ok: false, reason: "ABORTED" }); return; }
        const payload = Buffer.from(String(spec.body), "utf8");
        timeout = timeoutSignal(spec.timeoutMs);
        if (timeout.aborted) { onTimeout(); return; }
        timeout.addEventListener("abort", onTimeout);
        if (outer) outer.addEventListener("abort", onAbort);
        req = request(spec.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${spec.apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
            "content-length": payload.length,
            "user-agent": USER_AGENT,
          },
        }, onResponse);
        if (req && typeof req.on === "function") req.on("error", netError);
        if (req && typeof req.end === "function") req.end(payload);
      } catch (err) {
        netError(err);
        destroy();
      }
    });
  }

  return { post };
}

function createDefaultChatTransport() {
  let https = null;
  const request = (url, opts, cb) => {
    if (!https) https = require("node:https");
    return https.request(url, opts, cb);
  };
  return createChatTransport({ request });
}

module.exports = { createChatTransport, createDefaultChatTransport };
