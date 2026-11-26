"use strict";

const { createPoller } = require("../presence/poller");
const { STATE, BREAKER, METRICS, REJECT_REASONS, LANES, chatterAiSettingsOf, apiKeyOf } = require("./schema");
const { createRequestWindow, createDailyBudget, createBreaker } = require("./limits");
const { createTemplatePool } = require("./pool");
const { buildRequestBody, buildTalkBody, buildNewsBody, buildPlotBody } = require("./prompt");
const { parseCompletion, filterTemplates, filterTalkLine, filterNewsText, filterPlotText } = require("./filter");
const { createDefaultChatTransport } = require("./transport");

const WORK_CLASS = "MAINTENANCE";
const CHARS_PER_TOKEN = 4;
const COMPLETIONS_PATH = "/chat/completions";
const HTTP_AUTH = Object.freeze([401, 403]);
const HTTP_RETRYABLE_4XX = Object.freeze([408, 429]);
const COUNTER_NAMES = Object.freeze(["requests", "ok", "failed", "timeouts", "netErrors", "http4xx", "http5xx",
  "http429", "rateLimited", "budgetExhausted", "breakerBlocked", "deferred", "linesAccepted", "linesRejected",
  "bucketBackoffs", "voiceBudgetExhausted", ...REJECT_REASONS.map((r) => `rejected_${r}`),
  "talkBudgetExhausted", "talkInFlightBlocked", "talkRejected",
  "newsBudgetExhausted", "newsInFlightBlocked", "newsRejected",
  "plotBudgetExhausted", "plotInFlightBlocked", "plotRejected"]);
const VOICE_LANE = "voice";
const PERMILLE = 1000;
const LANE_FIELDS = Object.freeze(["requests", "linesAccepted", "tokens"]);
const CONTENT_FAILURES = Object.freeze(["ALL_REJECTED", "EMPTY"]);
const BUCKET_BACKOFF_GROWTH = 2;
const COUNTED_METRICS = Object.freeze(["requests", "failed", "tokens", "linesAccepted", "linesRejected",
  "breakerOpened", "voiceRequests", "talkRequests", "newsRequests", "plotRequests"]);
const TALK_LANE = "talk";
const TALK_ROLES = Object.freeze(["system", "user"]);
const TALK_MAX_MESSAGES = 2;
const NEWS_LANE = "news";
const NEWS_MAX_IN_FLIGHT = 1;
const PLOT_LANE = "plot";
const PLOT_MAX_IN_FLIGHT = 1;

function onDemandSpecOk(spec, lane, maxPromptChars) {
  if (!spec || typeof spec !== "object" || spec.lane !== lane) return false;
  const m = spec.messages;
  if (!Array.isArray(m) || m.length < 1 || m.length > TALK_MAX_MESSAGES) return false;
  for (const x of m) {
    if (!x || typeof x !== "object" || !TALK_ROLES.includes(x.role) || typeof x.content !== "string"
      || x.content.length > maxPromptChars) return false;
  }
  return Number.isSafeInteger(spec.minChars) && Number.isSafeInteger(spec.maxChars) && spec.minChars > 0
    && spec.maxChars >= spec.minChars;
}

function talkSpecOk(spec, S) {
  return onDemandSpecOk(spec, TALK_LANE, S.talkMaxPromptChars);
}

function newsSpecOk(spec, S) {
  return onDemandSpecOk(spec, NEWS_LANE, S.newsMaxPromptChars)
    && (spec.onAccepted === undefined || typeof spec.onAccepted === "function");
}

function plotSpecOk(spec, S) {
  return onDemandSpecOk(spec, PLOT_LANE, S.plotMaxPromptChars)
    && (spec.onAccepted === undefined || typeof spec.onAccepted === "function");
}

function noop() {}

function codeOf(err) {
  const code = err && err.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "ERROR";
}

function safeReason(reason) {
  return String(reason || "unavailable").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
}

function tokensOf(text) {
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

function createOffChatterAi() {
  return Object.freeze({
    overlay: () => ({ ok: false, reason: "OFF" }),
    demand: noop,
    complete: () => Promise.resolve({ ok: false, reason: "OFF" }),
    getStatus: () => ({ state: STATE.OFF }),
    stop: noop,
  });
}

function createUnavailableChatterAi(reason) {
  const lastError = safeReason(reason);
  return Object.freeze({
    overlay: () => ({ ok: false, reason: "DISABLED" }),
    demand: noop,
    complete: () => Promise.resolve({ ok: false, reason: "DISABLED" }),
    getStatus: () => ({ state: STATE.DISABLED, lastError }),
    stop: noop,
  });
}

function startChatterAi(deps) {
  try {
    const config = (deps && deps.config) || {};
    const C = config.chatterAi;
    if (!C || C.enabled !== true) return { ok: true, chatterAi: createOffChatterAi() };
    return { ok: true, chatterAi: createChatterAiService(deps, config) };
  } catch (err) {
    return { ok: false, reason: "CHATTER_AI_START_FAILED", detail: codeOf(err) };
  }
}

function createChatterAiService(deps, config) {
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => clock.now();
  const telemetry = deps.telemetry && typeof deps.telemetry.count === "function" ? deps.telemetry : null;
  const buckets = Array.isArray(deps.buckets) ? deps.buckets : [];
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  const logged = new Set();

  const settingsRes = chatterAiSettingsOf(config);
  const S = settingsRes.ok ? settingsRes.settings : null;
  const apiKey = apiKeyOf(config);
  const apiKeySet = apiKey !== "";
  const host = S ? new URL(S.baseUrl).host : null;
  const reqWindow = createRequestWindow(S ? S.maxRequestsPerMinute : 0);
  const budget = createDailyBudget(S ? S.dailyTokenBudget : 0);
  const voiceBudget = createDailyBudget(S ? Math.floor(S.dailyTokenBudget * S.voiceTokenSharePermille / PERMILLE) : 0);
  const talkBudget = createDailyBudget(S ? Math.floor(S.dailyTokenBudget * S.talkTokenSharePermille / PERMILLE) : 0);
  const talkEnabled = deps.talkEnabled === true;
  const newsBudget = createDailyBudget(S ? Math.floor(S.dailyTokenBudget * S.newsTokenSharePermille / PERMILLE) : 0);
  const newsEnabled = deps.newsEnabled === true;
  let newsInFlight = 0;
  const plotBudget = createDailyBudget(S ? Math.floor(S.dailyTokenBudget * S.plotTokenSharePermille / PERMILLE) : 0);
  const plotEnabled = deps.plotEnabled === true;
  let plotInFlight = 0;
  const refillRpmCap = S ? S.maxRequestsPerMinute - (talkEnabled ? S.talkReservedPerMinute : 0) : 0;
  let talkInFlight = 0;
  const bucketKeys = new Set(buckets.filter((b) => b && typeof b.key === "string").map((b) => b.key));
  const demandAt = new Map();
  const byLane = Object.fromEntries(LANES.map((lane) => [lane, Object.fromEntries(LANE_FIELDS.map((f) => [f, 0]))]));
  const breaker = S ? createBreaker(S) : null;
  const pool = createTemplatePool(S || {});
  const pending = new Set();
  const inFlightBuckets = new Set();
  const bucketBackoff = new Map();
  let inFlight = 0;
  let state = STATE.RUNNING;
  let stopped = false;
  let lastError = null;
  let poller = null;
  let transport = null;
  let url = null;

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }
  function logOnce(key, line) {
    if (logged.has(key)) return;
    logged.add(key);
    log(line);
  }
  function metric(fn) {
    if (!telemetry) return;
    try {
      fn(telemetry);
    } catch (_err) {
    }
  }
  function governorAdmits() {
    try {
      const g = typeof deps.getGovernor === "function" ? deps.getGovernor() : null;
      return !g || typeof g.admits !== "function" || g.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }
  function settleTalk(req, result) {
    if (!req.onDemand || req.onDemand.settled) return;
    req.onDemand.settled = true;
    try {
      req.onDemand.resolve(result);
    } catch (_err) {
    }
  }
  function abortPending() {
    for (const req of pending) {
      try {
        req.controller.abort();
      } catch (_err) {
      }
      settleTalk(req, { ok: false, reason: stopped ? "STOPPED" : "DISABLED" });
    }
  }
  function disable(code) {
    state = STATE.DISABLED;
    lastError = code;
    if (poller) poller.stop();
    abortPending();
    logOnce(`DISABLED_${code}`, `chatterAi: disabled - ${code}`);
  }

  function backedOff(key, now) {
    const entry = bucketBackoff.get(key);
    return entry !== undefined && now < entry.retryAt;
  }

  function backOffBucket(key, now) {
    const prev = bucketBackoff.get(key);
    const strikes = prev ? prev.strikes + 1 : 1;
    const maxCd = Math.max(S.breakerCooldownMs, S.breakerMaxCooldownMs);
    let wait = S.breakerCooldownMs;
    for (let i = 1; i < strikes && wait < maxCd; i += 1) wait *= BUCKET_BACKOFF_GROWTH;
    bucketBackoff.set(key, { strikes, retryAt: now + Math.min(wait, maxCd) });
    counters.bucketBackoffs += 1;
  }

  function noteDemand(bucketKey) {
    try {
      if (typeof bucketKey !== "string" || !bucketKeys.has(bucketKey)) return;
      demandAt.set(bucketKey, nowMs());
    } catch (_err) {
    }
  }

  function wanted(b, now) {
    if (b.onDemand !== true) return true;
    const at = demandAt.get(b.key);
    return at !== undefined && now - at <= S.demandWindowMs;
  }

  function laneOf(b) {
    return b && typeof b.lane === "string" && Object.prototype.hasOwnProperty.call(byLane, b.lane) ? b.lane : null;
  }

  function laneAdd(b, field, n) {
    const lane = laneOf(b);
    if (lane !== null) byLane[lane][field] += n;
  }

  function pickBucket(now, skipVoice) {
    let best = null;
    let bestSize = Infinity;
    for (const b of buckets) {
      if (!b || typeof b.key !== "string" || inFlightBuckets.has(b.key) || backedOff(b.key, now)) continue;
      if ((skipVoice && b.lane === VOICE_LANE) || !wanted(b, now)) continue;
      const size = pool.sizeOf(b.key);
      if (size < S.lowWaterPerBucket && size < bestSize) {
        best = b;
        bestSize = size;
      }
    }
    return best;
  }

  function fail(now, code, retryAfterMs) {
    counters.failed += 1;
    metric((t) => t.count(METRICS.failed, 1));
    lastError = code;
    const before = breaker.opened;
    breaker.failure(now, retryAfterMs);
    if (breaker.opened > before) {
      metric((t) => t.count(METRICS.breakerOpened, 1));
      logOnce(`OPEN_${code}`, `chatterAi: breaker open - ${code}`);
    }
  }

  function contentFail(now, key, code) {
    counters.failed += 1;
    metric((t) => t.count(METRICS.failed, 1));
    lastError = code;
    breaker.success(now);
    backOffBucket(key, now);
  }

  function spendTokens(b, tokens, now) {
    budget.spend(tokens, now);
    if (b.lane === VOICE_LANE) voiceBudget.spend(tokens, now);
    laneAdd(b, "tokens", tokens);
    metric((t) => t.count(METRICS.tokens, tokens));
  }

  function onCompletion(req, res, now) {
    const b = req.bucket;
    const parsed = parseCompletion(res.json);
    if (!parsed.ok) {
      const used = Number.isSafeInteger(parsed.totalTokens) ? parsed.totalTokens : tokensOf(req.body) + S.maxTokens;
      spendTokens(b, used, now);
      if (CONTENT_FAILURES.includes(parsed.reason)) {
        contentFail(now, b.key, parsed.reason);
        return;
      }
      fail(now, parsed.reason, null);
      backOffBucket(b.key, now);
      return;
    }
    const known = new Set([...(b.staticNormalized || []), ...pool.knownNormalized(b.key)]);
    const { accepted, rejected } = filterTemplates(parsed.text, b, S, known);
    pool.add(b.key, accepted, now);
    const tokens = parsed.totalTokens !== null ? parsed.totalTokens : tokensOf(req.body) + tokensOf(parsed.text);
    spendTokens(b, tokens, now);
    laneAdd(b, "linesAccepted", accepted.length);
    let rejectedTotal = 0;
    for (const reason of REJECT_REASONS) {
      const n = rejected[reason] || 0;
      counters[`rejected_${reason}`] += n;
      rejectedTotal += n;
    }
    counters.linesAccepted += accepted.length;
    counters.linesRejected += rejectedTotal;
    metric((t) => {
      t.count(METRICS.linesAccepted, accepted.length);
      t.count(METRICS.linesRejected, rejectedTotal);
    });
    if (accepted.length === 0) {
      contentFail(now, b.key, "ALL_REJECTED");
      return;
    }
    counters.ok += 1;
    bucketBackoff.delete(b.key);
    breaker.success(now);
  }

  function onFailure(res, now) {
    const reason = res && typeof res.reason === "string" ? res.reason : "NET_ERROR";
    if (reason === "ABORTED") return;
    if (reason === "HTTP_STATUS") {
      const status = Number.isInteger(res.status) ? res.status : 0;
      const code = `HTTP_${status}`;
      if (status === 429) counters.http429 += 1;
      else if (status >= 400 && status < 500) counters.http4xx += 1;
      else if (status >= 500) counters.http5xx += 1;
      if (HTTP_AUTH.includes(status)) {
        counters.failed += 1;
        metric((t) => t.count(METRICS.failed, 1));
        disable("AUTH_REJECTED");
        return;
      }
      if (status >= 400 && status < 500 && !HTTP_RETRYABLE_4XX.includes(status)) {
        counters.failed += 1;
        metric((t) => t.count(METRICS.failed, 1));
        disable(code);
        return;
      }
      fail(now, code, Number.isFinite(res.retryAfterMs) ? res.retryAfterMs : null);
      return;
    }
    if (reason === "TIMEOUT") counters.timeouts += 1;
    else if (reason === "NET_ERROR") counters.netErrors += 1;
    fail(now, /^[A-Z_]{1,40}$/.test(reason) ? reason : "NET_ERROR", null);
  }

  function spendTalkTokens(tokens, now) {
    budget.spend(tokens, now);
    talkBudget.spend(tokens, now);
    byLane.talk.tokens += tokens;
    metric((t) => t.count(METRICS.tokens, tokens));
  }

  function onTalkCompletion(req, res, now) {
    const parsed = parseCompletion(res.json);
    if (!parsed.ok) {
      const used = Number.isSafeInteger(parsed.totalTokens) ? parsed.totalTokens : tokensOf(req.body) + S.talkMaxTokens;
      spendTalkTokens(used, now);
      if (CONTENT_FAILURES.includes(parsed.reason)) {
        counters.failed += 1;
        metric((t) => t.count(METRICS.failed, 1));
        lastError = parsed.reason;
        breaker.success(now);
        return { ok: false, reason: parsed.reason };
      }
      fail(now, parsed.reason, null);
      return { ok: false, reason: parsed.reason };
    }
    const tokens = parsed.totalTokens !== null ? parsed.totalTokens : tokensOf(req.body) + tokensOf(parsed.text);
    spendTalkTokens(tokens, now);
    const filtered = filterTalkLine(parsed.text, req.onDemand.spec, S);
    breaker.success(now);
    if (!filtered.ok) {
      const code = `REJECTED_${filtered.reason}`;
      counters.talkRejected += 1;
      counters.failed += 1;
      metric((t) => t.count(METRICS.failed, 1));
      lastError = code;
      return { ok: false, reason: code };
    }
    counters.ok += 1;
    byLane.talk.linesAccepted += 1;
    return { ok: true, line: filtered.line, tokens, ms: Math.max(0, now - req.t0) };
  }

  function talkFailureReason(res, now) {
    onFailure(res, now);
    const reason = res && typeof res.reason === "string" ? res.reason : "NET_ERROR";
    if (reason === "ABORTED") return stopped ? "STOPPED" : "DISABLED";
    if (reason !== "HTTP_STATUS") return /^[A-Z_]{1,40}$/.test(reason) ? reason : "NET_ERROR";
    const status = Number.isInteger(res.status) ? res.status : 0;
    if (HTTP_AUTH.includes(status)) return "AUTH_REJECTED";
    if (status === 429) return "HTTP_429";
    if (status >= 500) return "HTTP_5XX";
    return `HTTP_${status}`;
  }

  function spendNewsTokens(tokens, now) {
    budget.spend(tokens, now);
    newsBudget.spend(tokens, now);
    byLane.news.tokens += tokens;
    metric((t) => t.count(METRICS.tokens, tokens));
  }

  function onNewsCompletion(req, res, now) {
    const parsed = parseCompletion(res.json);
    if (!parsed.ok) {
      const used = Number.isSafeInteger(parsed.totalTokens) ? parsed.totalTokens : tokensOf(req.body) + S.newsMaxTokens;
      spendNewsTokens(used, now);
      if (CONTENT_FAILURES.includes(parsed.reason)) {
        counters.failed += 1;
        metric((t) => t.count(METRICS.failed, 1));
        lastError = parsed.reason;
        breaker.success(now);
        return { ok: false, reason: parsed.reason };
      }
      fail(now, parsed.reason, null);
      return { ok: false, reason: parsed.reason };
    }
    const tokens = parsed.totalTokens !== null ? parsed.totalTokens : tokensOf(req.body) + tokensOf(parsed.text);
    spendNewsTokens(tokens, now);
    const filtered = filterNewsText(parsed.text, req.onDemand.spec, S);
    breaker.success(now);
    if (!filtered.ok) {
      const code = `REJECTED_${filtered.reason}`;
      counters.newsRejected += 1;
      counters.failed += 1;
      metric((t) => t.count(METRICS.failed, 1));
      lastError = code;
      return { ok: false, reason: code, tokens };
    }
    counters.ok += 1;
    byLane.news.linesAccepted += 1;
    return { ok: true, text: filtered.text, tokens, ms: Math.max(0, now - req.t0) };
  }

  function spendPlotTokens(tokens, now) {
    budget.spend(tokens, now);
    plotBudget.spend(tokens, now);
    byLane.plot.tokens += tokens;
    metric((t) => t.count(METRICS.tokens, tokens));
  }

  function onPlotCompletion(req, res, now) {
    const parsed = parseCompletion(res.json);
    if (!parsed.ok) {
      const used = Number.isSafeInteger(parsed.totalTokens) ? parsed.totalTokens : tokensOf(req.body) + S.plotMaxTokens;
      spendPlotTokens(used, now);
      if (CONTENT_FAILURES.includes(parsed.reason)) {
        counters.failed += 1;
        metric((t) => t.count(METRICS.failed, 1));
        lastError = parsed.reason;
        breaker.success(now);
        return { ok: false, reason: parsed.reason };
      }
      fail(now, parsed.reason, null);
      return { ok: false, reason: parsed.reason };
    }
    const tokens = parsed.totalTokens !== null ? parsed.totalTokens : tokensOf(req.body) + tokensOf(parsed.text);
    spendPlotTokens(tokens, now);
    const filtered = filterPlotText(parsed.text, req.onDemand.spec);
    breaker.success(now);
    if (!filtered.ok) {
      const code = `REJECTED_${filtered.reason}`;
      counters.plotRejected += 1;
      counters.failed += 1;
      metric((t) => t.count(METRICS.failed, 1));
      lastError = code;
      return { ok: false, reason: code, tokens };
    }
    counters.ok += 1;
    byLane.plot.linesAccepted += 1;
    return { ok: true, text: filtered.text, tokens, ms: Math.max(0, now - req.t0) };
  }

  function onTalkResult(req, res) {
    const news = req.onDemand.lane === NEWS_LANE;
    const plot = req.onDemand.lane === PLOT_LANE;
    if (news) newsInFlight = Math.max(0, newsInFlight - 1);
    else if (plot) plotInFlight = Math.max(0, plotInFlight - 1);
    else talkInFlight = Math.max(0, talkInFlight - 1);
    if (stopped) {
      settleTalk(req, { ok: false, reason: "STOPPED" });
      return;
    }
    if (state !== STATE.RUNNING) {
      settleTalk(req, { ok: false, reason: "DISABLED" });
      return;
    }
    const now = nowMs();
    metric((t) => t.observe(METRICS.requestMs, Math.max(0, now - req.t0)));
    if (res && res.ok === true) {
      let result;
      if (news) result = onNewsCompletion(req, res, now);
      else if (plot) result = onPlotCompletion(req, res, now);
      else result = onTalkCompletion(req, res, now);
      settleTalk(req, result);
    } else settleTalk(req, { ok: false, reason: talkFailureReason(res, now) });
  }

  function onResult(req, res) {
    try {
      if (!pending.delete(req)) return;
      if (req.onDemand) {
        onTalkResult(req, res);
        return;
      }
      inFlight = Math.max(0, inFlight - 1);
      inFlightBuckets.delete(req.bucket.key);
      if (stopped || state !== STATE.RUNNING) return;
      const now = nowMs();
      metric((t) => t.observe(METRICS.requestMs, Math.max(0, now - req.t0)));
      if (res && res.ok === true) onCompletion(req, res, now);
      else onFailure(res, now);
    } catch (err) {
      lastError = "RESULT_FAILED";
      logOnce(`RESULT_${codeOf(err)}`, `chatterAi: result failed - ${codeOf(err)}`);
      try {
        if (breaker) breaker.failure(nowMs(), null);
      } catch (_err) {
      }
      try {
        if (S && req && req.bucket && typeof req.bucket.key === "string") backOffBucket(req.bucket.key, nowMs());
      } catch (_err) {
      }
      settleTalk(req, { ok: false, reason: "BAD_SHAPE" });
    }
  }

  function post(req, body) {
    let promise;
    try {
      if (transport === null) transport = deps.transport && typeof deps.transport.post === "function"
        ? deps.transport : createDefaultChatTransport();
      const timeoutMs = Number.isSafeInteger(req.timeoutMs) ? req.timeoutMs : S.timeoutMs;
      promise = Promise.resolve(transport.post({ url, apiKey, body, timeoutMs,
        maxBytes: S.maxResponseBytes, signal: req.controller.signal }));
    } catch (_err) {
      promise = Promise.resolve({ ok: false, reason: "NET_ERROR" });
    }
    promise.then((res) => onResult(req, res), () => onResult(req, { ok: false, reason: "NET_ERROR" }));
  }

  function dispatch(bucket, body, now) {
    const controller = new AbortController();
    const req = { bucket, body, t0: now, controller };
    pending.add(req);
    inFlight += 1;
    inFlightBuckets.add(bucket.key);
    counters.requests += 1;
    metric((t) => t.count(METRICS.requests, 1));
    laneAdd(bucket, "requests", 1);
    if (bucket.lane === VOICE_LANE) metric((t) => t.count(METRICS.voiceRequests, 1));
    post(req, body);
  }

  function dispatchTalk(spec, body, now) {
    return new Promise((resolve) => {
      const req = { bucket: null, body, t0: now, controller: new AbortController(),
        onDemand: { lane: TALK_LANE, resolve, spec, settled: false } };
      pending.add(req);
      talkInFlight += 1;
      counters.requests += 1;
      byLane.talk.requests += 1;
      metric((t) => {
        t.count(METRICS.requests, 1);
        t.count(METRICS.talkRequests, 1);
      });
      post(req, body);
    });
  }

  function startTalk(spec) {
    if (stopped) return { ok: false, reason: "STOPPED" };
    if (state !== STATE.RUNNING) return { ok: false, reason: "DISABLED" };
    if (!talkSpecOk(spec, S)) return { ok: false, reason: "BAD_SPEC" };
    const now = nowMs();
    if (!breaker.allow(now)) {
      counters.breakerBlocked += 1;
      return { ok: false, reason: "BREAKER_OPEN" };
    }
    const refuse = (counter, reason) => {
      counters[counter] += 1;
      breaker.release();
      return { ok: false, reason };
    };
    if (reqWindow.inWindow(now) >= S.maxRequestsPerMinute) return refuse("rateLimited", "RATE_LIMITED");
    const body = buildTalkBody(spec.messages, S);
    const need = S.talkMaxTokens + tokensOf(body);
    if (!budget.canSpend(need, now)) return refuse("budgetExhausted", "BUDGET");
    if (!talkBudget.canSpend(need, now)) return refuse("talkBudgetExhausted", "TALK_BUDGET");
    if (talkInFlight >= S.talkMaxInFlight) return refuse("talkInFlightBlocked", "TALK_IN_FLIGHT");
    reqWindow.tryTake(now);
    return dispatchTalk(spec, body, now);
  }

  function dispatchNews(spec, body, now) {
    return new Promise((resolve) => {
      const req = { bucket: null, body, t0: now, controller: new AbortController(), timeoutMs: S.newsTimeoutMs,
        onDemand: { lane: NEWS_LANE, resolve, spec, settled: false } };
      pending.add(req);
      newsInFlight += 1;
      counters.requests += 1;
      byLane.news.requests += 1;
      metric((t) => {
        t.count(METRICS.requests, 1);
        t.count(METRICS.newsRequests, 1);
      });
      post(req, body);
    });
  }

  function startNewsRequest(spec) {
    if (stopped) return { ok: false, reason: "STOPPED" };
    if (state !== STATE.RUNNING) return { ok: false, reason: "DISABLED" };
    if (!newsSpecOk(spec, S)) return { ok: false, reason: "BAD_SPEC" };
    const now = nowMs();
    if (!breaker.allow(now)) {
      counters.breakerBlocked += 1;
      return { ok: false, reason: "BREAKER_OPEN" };
    }
    const refuse = (counter, reason) => {
      if (counter !== null) counters[counter] += 1;
      breaker.release();
      return { ok: false, reason };
    };
    if (reqWindow.inWindow(now) >= S.maxRequestsPerMinute) return refuse("rateLimited", "RATE_LIMITED");
    const body = buildNewsBody(spec.messages, S);
    const need = S.newsMaxTokens + tokensOf(body);
    if (!budget.canSpend(need, now)) return refuse("budgetExhausted", "BUDGET");
    if (!newsBudget.canSpend(need, now)) return refuse("newsBudgetExhausted", "NEWS_BUDGET");
    if (newsInFlight >= NEWS_MAX_IN_FLIGHT) return refuse("newsInFlightBlocked", "NEWS_IN_FLIGHT");
    if (typeof spec.onAccepted === "function") {
      let go = false;
      try {
        go = spec.onAccepted() !== false;
      } catch (_err) {
        go = false;
      }
      if (!go) return refuse(null, "ABORTED");
    }
    reqWindow.tryTake(now);
    return dispatchNews(spec, body, now);
  }

  function dispatchPlot(spec, body, now) {
    return new Promise((resolve) => {
      const req = { bucket: null, body, t0: now, controller: new AbortController(), timeoutMs: S.plotTimeoutMs,
        onDemand: { lane: PLOT_LANE, resolve, spec, settled: false } };
      pending.add(req);
      plotInFlight += 1;
      counters.requests += 1;
      byLane.plot.requests += 1;
      metric((t) => {
        t.count(METRICS.requests, 1);
        t.count(METRICS.plotRequests, 1);
      });
      post(req, body);
    });
  }

  function startPlotRequest(spec) {
    if (stopped) return { ok: false, reason: "STOPPED" };
    if (state !== STATE.RUNNING) return { ok: false, reason: "DISABLED" };
    if (!plotSpecOk(spec, S)) return { ok: false, reason: "BAD_SPEC" };
    const now = nowMs();
    if (!breaker.allow(now)) {
      counters.breakerBlocked += 1;
      return { ok: false, reason: "BREAKER_OPEN" };
    }
    const refuse = (counter, reason) => {
      if (counter !== null) counters[counter] += 1;
      breaker.release();
      return { ok: false, reason };
    };
    if (reqWindow.inWindow(now) >= S.maxRequestsPerMinute) return refuse("rateLimited", "RATE_LIMITED");
    const body = buildPlotBody(spec.messages, S);
    const need = S.plotMaxTokens + tokensOf(body);
    if (!budget.canSpend(need, now)) return refuse("budgetExhausted", "BUDGET");
    if (!plotBudget.canSpend(need, now)) return refuse("plotBudgetExhausted", "PLOT_BUDGET");
    if (plotInFlight >= PLOT_MAX_IN_FLIGHT) return refuse("plotInFlightBlocked", "PLOT_IN_FLIGHT");
    if (typeof spec.onAccepted === "function") {
      let go = false;
      try {
        go = spec.onAccepted() !== false;
      } catch (_err) {
        go = false;
      }
      if (!go) return refuse(null, "ABORTED");
    }
    reqWindow.tryTake(now);
    return dispatchPlot(spec, body, now);
  }

  function refillPass() {
    if (state !== STATE.RUNNING || stopped) return;
    if (!governorAdmits()) {
      counters.deferred += 1;
      return;
    }
    const now = nowMs();
    pool.prune(now);
    let skipVoice = false;
    while (inFlight < S.maxInFlight) {
      const bucket = pickBucket(now, skipVoice);
      if (bucket === null) break;
      if (!breaker.allow(now)) {
        counters.breakerBlocked += 1;
        break;
      }
      if (reqWindow.inWindow(now) >= refillRpmCap) {
        counters.rateLimited += 1;
        breaker.release();
        break;
      }
      const body = buildRequestBody(bucket, S);
      const need = S.maxTokens + tokensOf(body);
      if (!budget.canSpend(need, now)) {
        counters.budgetExhausted += 1;
        breaker.release();
        break;
      }
      if (bucket.lane === VOICE_LANE && !voiceBudget.canSpend(need, now)) {
        counters.voiceBudgetExhausted += 1;
        breaker.release();
        skipVoice = true;
        continue;
      }
      reqWindow.tryTake(now);
      dispatch(bucket, body, now);
    }
  }

  if (S === null) disable(`INVALID_SETTINGS:${settingsRes.detail}`);
  else if (!apiKeySet) disable("NO_API_KEY");
  else if (buckets.length === 0 && !talkEnabled && !newsEnabled && !plotEnabled) disable("NO_BUCKETS");
  else {
    url = new URL(`${S.baseUrl.replace(/\/+$/, "")}${COMPLETIONS_PATH}`);
    if (buckets.length > 0) {
      poller = createPoller({ runPass: refillPass, intervalMs: S.refillTickMs, now: nowMs, setTimer: deps.setTimer,
        onError: (err) => logOnce(`PASS_${codeOf(err)}`, `chatterAi: pass failed - ${codeOf(err)}`) });
    }
    metric((t) => {
      for (const name of COUNTED_METRICS) t.count(METRICS[name], 0);
    });
    if (poller) poller.start();
    log(`chatterAi: running host=${host} model=${S.model} buckets=${buckets.length} refillTickMs=${S.refillTickMs} `
      + `maxInFlight=${S.maxInFlight} maxRequestsPerMinute=${S.maxRequestsPerMinute} `
      + `dailyTokenBudget=${S.dailyTokenBudget}`
      + (talkEnabled ? ` talk=on talkReservedPerMinute=${S.talkReservedPerMinute} talkMaxInFlight=${S.talkMaxInFlight}`
        : "")
      + (newsEnabled ? ` news=on newsMaxTokens=${S.newsMaxTokens}` : "")
      + (plotEnabled ? ` plot=on plotMaxTokens=${S.plotMaxTokens}` : ""));
  }

  function getStatus() {
    const now = nowMs();
    const t = pool.totals();
    const out = {
      state,
      breaker: breaker ? breaker.state(now) : BREAKER.CLOSED,
      inFlight,
      requestsLastMinute: reqWindow.inWindow(now),
      tokensToday: budget.usedToday(now),
      dailyTokenBudget: S ? S.dailyTokenBudget : 0,
      model: S ? S.model : null,
      host,
      apiKeySet,
      buckets: { total: buckets.length, filled: t.filled, lines: t.lines },
      counters: { ...counters },
      byLane: Object.fromEntries(LANES.map((lane) => [lane, { ...byLane[lane] }])),
      voiceTokensToday: voiceBudget.usedToday(now),
      talkTokensToday: talkBudget.usedToday(now),
      talkInFlight,
      newsTokensToday: newsBudget.usedToday(now),
      newsInFlight,
      plotTokensToday: plotBudget.usedToday(now),
      plotInFlight,
    };
    if (lastError !== null) out.lastError = lastError;
    return out;
  }

  return Object.freeze({
    overlay() {
      try {
        if (state !== STATE.RUNNING) return { ok: false, reason: "DISABLED" };
        if (pool.totals().lines === 0) return { ok: false, reason: "EMPTY" };
        return { ok: true, permille: S.usePermille, linesOf: (bucketKey) => {
          noteDemand(bucketKey);
          return pool.linesOf(bucketKey);
        } };
      } catch (_err) {
        return { ok: false, reason: "DISABLED" };
      }
    },
    demand(bucketKey) {
      noteDemand(bucketKey);
    },
    complete(spec) {
      try {
        if (spec && typeof spec === "object" && spec.lane === NEWS_LANE) return Promise.resolve(startNewsRequest(spec));
        if (spec && typeof spec === "object" && spec.lane === PLOT_LANE) return Promise.resolve(startPlotRequest(spec));
        return Promise.resolve(startTalk(spec));
      } catch (_err) {
        return Promise.resolve({ ok: false, reason: "BAD_SPEC" });
      }
    },
    getStatus() {
      try {
        return getStatus();
      } catch (_err) {
        return { state, apiKeySet, host, lastError: "STATUS_FAILED" };
      }
    },
    stop(reason) {
      if (stopped) return;
      stopped = true;
      state = STATE.STOPPED;
      if (poller) poller.stop();
      abortPending();
      log(`chatterAi: stopped (${safeReason(reason || "stop")}) inFlight=${inFlight}`);
    },
  });
}

module.exports = { startChatterAi, createUnavailableChatterAi, COUNTER_NAMES, WORK_CLASS };
