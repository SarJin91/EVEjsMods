"use strict";

const USER_AGENT = "LivingNewEden-shipAiVoice";
const SYNTHESIZE_PATH = "synthesize";
const VOICES_PATH = "voices";
const MAX_URL_CHARS = 512;
const HTTP_OK = 200;

function declaredLength(res) {
  const raw = res && res.headers && typeof res.headers === "object" ? res.headers["content-length"] : undefined;
  const n = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

function parsePiperUrl(text) {
  const bad = { ok: false, reason: "PIPER_URL_INVALID" };
  if (typeof text !== "string" || text === "" || text.length > MAX_URL_CHARS || /[\s\u0000-\u001f\u007f]/.test(text)) {
    return bad;
  }
  let url;
  try {
    url = new URL(text);
  } catch (_err) {
    return bad;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return bad;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || /[?#]/.test(text)) {
    return bad;
  }
  if (url.hostname === "") return bad;
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return { ok: true, url, synthesizeUrl: new URL(SYNTHESIZE_PATH, url), voicesUrl: new URL(VOICES_PATH, url) };
}

function createPiperTransport(deps) {
  const request = deps && deps.request;
  const timeoutSignal = deps && typeof deps.timeoutSignal === "function"
    ? deps.timeoutSignal : (ms) => AbortSignal.timeout(ms);

  function send(method, url, json, opts) {
    return new Promise((resolve) => {
      let settled = false;
      let req = null;
      let timeout = null;
      const outer = opts && opts.signal ? opts.signal : null;
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
      const netError = () => {
        if (outer && outer.aborted) settle({ ok: false, reason: "ABORTED" });
        else settle({ ok: false, reason: "NET_ERROR" });
      };
      function onTimeout() { settle({ ok: false, reason: "TIMEOUT" }); destroy(); }
      function onAbort() { settle({ ok: false, reason: "ABORTED" }); destroy(); }
      const onResponse = (res) => {
        try {
          const status = res && Number.isInteger(res.statusCode) ? res.statusCode : 0;
          if (status !== HTTP_OK) {
            try { res.resume(); } catch (_err) {}
            settle({ ok: false, reason: `HTTP_${status}` });
            return;
          }
          const maxBytes = opts.maxBytes;
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
          res.on("end", () => settle({ ok: true, bytes: Buffer.concat(chunks), status: HTTP_OK }));
          res.on("error", netError);
          res.on("aborted", netError);
        } catch (_err) {
          netError();
          destroy();
        }
      };

      try {
        if (typeof request !== "function" || !(url instanceof URL) || !opts || !Number.isSafeInteger(opts.maxBytes)
          || opts.maxBytes <= 0) {
          settle({ ok: false, reason: "NET_ERROR" });
          return;
        }
        if (outer && outer.aborted) {
          settle({ ok: false, reason: "ABORTED" });
          return;
        }
        const payload = method === "GET" ? null : Buffer.from(JSON.stringify(json), "utf8");
        timeout = timeoutSignal(opts.timeoutMs);
        if (timeout.aborted) {
          onTimeout();
          return;
        }
        timeout.addEventListener("abort", onTimeout);
        if (outer) outer.addEventListener("abort", onAbort);
        const headers = payload === null ? { accept: "application/json", "user-agent": USER_AGENT }
          : { "content-type": "application/json", accept: "audio/wav", "content-length": payload.length,
            "user-agent": USER_AGENT };
        req = request(url, { method, headers }, onResponse);
        if (req && typeof req.on === "function") req.on("error", netError);
        if (req && typeof req.end === "function") {
          if (payload === null) req.end();
          else req.end(payload);
        }
      } catch (_err) {
        netError();
        destroy();
      }
    });
  }

  function post(url, json, opts) {
    return send("POST", url, json, opts);
  }

  function get(url, opts) {
    return send("GET", url, undefined, opts);
  }

  return Object.freeze({ post, get });
}

function createDefaultPiperTransport() {
  const mods = { "http:": null, "https:": null };
  const request = (url, opts, cb) => {
    const proto = url.protocol === "https:" ? "https:" : "http:";
    if (!mods[proto]) mods[proto] = proto === "https:" ? require("node:https") : require("node:http");
    return mods[proto].request(url, opts, cb);
  };
  return createPiperTransport({ request });
}

module.exports = { parsePiperUrl, createPiperTransport, createDefaultPiperTransport, SYNTHESIZE_PATH };
