"use strict";

const USER_AGENT = "LivingNewEden-alerts";
const CODE_RE = /^[A-Z0-9_]{1,40}$/;

function codeOf(err) {
  const code = err && err.code;
  return typeof code === "string" && CODE_RE.test(code) ? code : null;
}

function createWebhookSender(deps) {
  const request = deps && deps.request;
  const timeoutSignal = deps && typeof deps.timeoutSignal === "function"
    ? deps.timeoutSignal : (ms) => AbortSignal.timeout(ms);

  return function send(url, body, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let req = null;
      let signal = null;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        if (signal) {
          try { signal.removeEventListener("abort", onTimeout); } catch (_err) {}
        }
        resolve(value);
      };
      const destroy = () => {
        try { if (req && typeof req.destroy === "function") req.destroy(); } catch (_err) {}
      };
      const netError = (err) => {
        const code = codeOf(err);
        settle(code ? { ok: false, reason: "NET_ERROR", code } : { ok: false, reason: "NET_ERROR" });
      };
      function onTimeout() {
        settle({ ok: false, reason: "TIMEOUT" });
        destroy();
      }
      try {
        if (typeof request !== "function") {
          settle({ ok: false, reason: "NET_ERROR" });
          return;
        }
        const payload = Buffer.from(String(body), "utf8");
        signal = timeoutSignal(timeoutMs);
        if (signal.aborted) {
          onTimeout();
          return;
        }
        signal.addEventListener("abort", onTimeout);
        req = request(url, {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": payload.length, "user-agent": USER_AGENT },
        }, (res) => {
          try { res.resume(); } catch (_err) {}
          const status = res && Number.isInteger(res.statusCode) ? res.statusCode : 0;
          if (status >= 200 && status < 300) settle({ ok: true, status });
          else settle({ ok: false, reason: "HTTP_STATUS", status });
        });
        if (req && typeof req.on === "function") req.on("error", netError);
        if (req && typeof req.end === "function") req.end(payload);
      } catch (err) {
        netError(err);
        destroy();
      }
    });
  };
}

module.exports = { createWebhookSender };
