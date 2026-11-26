"use strict";

const { createRequestWindow, createDailyBudget, createBreaker } = require("../chatterAi/limits");
const { BREAKER } = require("../chatterAi/schema");
const { parseCompletion } = require("../chatterAi/filter");
const { createDefaultChatTransport } = require("../chatterAi/transport");
const { METRIC, LANES } = require("./schema");
const { parseToolCalls } = require("./tools/protocol");

const CHARS_PER_TOKEN = 4;
const HTTP_BAD_REQUEST = 400;
const MILLI = 1000;
const PERMILLE = 1000;
const DAY_MS = 86400000;
const COMPLETIONS_PATH = "/chat/completions";
const HTTP_AUTH = Object.freeze([401, 403]);
const HTTP_RETRYABLE_4XX = Object.freeze([408, 429]);
const STATE = Object.freeze({ RUNNING: "running", DISABLED: "disabled", STOPPED: "stopped" });
const COUNTER_NAMES = Object.freeze(["requests", "ok", "failed", "timeouts", "netErrors", "http4xx", "http5xx",
  "http429", "breakerBlocked", "rateLimited", "budgetExhausted", "charBudgetExhausted", "laneBudgetExhausted",
  "empty", "badShape", "backgroundRateLimited"]);
const CHAT_LANE = "chat";
const LANE_PERMILLE_KEY = Object.freeze({ summary: "summaryLanePermille", proactive: "proactiveLanePermille",
  mail: "mailLanePermille" });

function noop() {}

const tokensOf = (text) => Math.ceil(String(text).length / CHARS_PER_TOKEN);
const hasTools = (spec) => Boolean(spec) && Array.isArray(spec.tools) && spec.tools.length > 0;
const hasToolHistory = (spec) => Boolean(spec) && Array.isArray(spec.messages) && spec.messages.some((m) =>
  Boolean(m) && (m.role === "tool" || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0)));

function createShipAiClient(deps) {
  const d = deps || {};
  const S = d.S || null;
  const apiKey = typeof d.apiKey === "string" ? d.apiKey : "";
  const nowMs = typeof d.nowMs === "function" ? d.nowMs : () => 0;
  const telemetry = d.telemetry && typeof d.telemetry.count === "function" ? d.telemetry : null;
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : { log: noop };
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const reqWindow = createRequestWindow(S ? S.maxRequestsPerMinute : 0);
  const bgMax = S && Number.isSafeInteger(S.backgroundMaxRequestsPerMinute) ? S.backgroundMaxRequestsPerMinute : 0;
  const bgWindow = createRequestWindow(bgMax);
  const budget = createDailyBudget(S ? S.dailyTokenBudget : 0);
  const laneBudgets = Object.fromEntries(LANES.filter((l) => LANE_PERMILLE_KEY[l]).map((l) => [l,
    createDailyBudget(S ? Math.floor(S.dailyTokenBudget * S[LANE_PERMILLE_KEY[l]] / PERMILLE) : 0)]));
  const breaker = S ? createBreaker(S) : null;
  const charUsed = new Map();
  let charDay = null;
  const pending = new Set();
  let thinkingDisabled = false;
  const thinkCounters = { requests: 0, empty: 0, cut: 0, retried: 0, rejected: 0, reasoningTokens: 0 };
  let inFlight = 0;
  let state = STATE.RUNNING;
  let lastError = null;
  let transport = null;
  const url = S ? new URL(`${S.baseUrl.replace(/\/+$/, "")}${COMPLETIONS_PATH}`) : null;
  const host = url ? url.host : null;

  const log = (line) => {
    try {
      logger.log(line);
    } catch (_err) {
    }
  };
  const metric = (fn) => {
    if (!telemetry) return;
    try {
      fn(telemetry);
    } catch (_err) {
    }
  };

  function disable(code) {
    if (state !== STATE.RUNNING) return;
    state = STATE.DISABLED;
    lastError = code;
    log(`shipAi client: disabled - ${code}`);
  }

  if (!S) disable(String(d.disabledReason || "INVALID_SETTINGS"));
  else if (apiKey === "") disable("NO_API_KEY");

  function rollCharDay(now) {
    const day = Math.floor(now / DAY_MS);
    if (day !== charDay) {
      charDay = day;
      charUsed.clear();
    }
  }

  function spend(playerId, lane, tokens, now) {
    budget.spend(tokens, now);
    if (laneBudgets[lane]) laneBudgets[lane].spend(tokens, now);
    rollCharDay(now);
    charUsed.set(playerId, (charUsed.get(playerId) || 0) + Math.ceil(tokens));
    metric((t) => t.count(METRIC.tokens, tokens));
  }

  function failed(code) {
    counters.failed += 1;
    lastError = code;
    metric((t) => t.count(METRIC.failed, 1));
  }

  function gate(spec, need, now) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "DISABLED" };
    if (!breaker.allow(now)) {
      counters.breakerBlocked += 1;
      return { ok: false, reason: "BREAKER" };
    }
    const refuse = (counter, reason) => {
      counters[counter] += 1;
      breaker.release();
      return { ok: false, reason };
    };
    if (reqWindow.inWindow(now) >= S.maxRequestsPerMinute) return refuse("rateLimited", "RATE");
    if (spec.lane !== CHAT_LANE && bgWindow.inWindow(now) >= bgMax) return refuse("backgroundRateLimited", "RATE");
    if (!budget.canSpend(need, now)) return refuse("budgetExhausted", "BUDGET");
    rollCharDay(now);
    const used = charUsed.get(spec.playerId) || 0;
    if (S.perCharacterDailyTokens <= 0 || used + need > S.perCharacterDailyTokens) {
      return refuse("charBudgetExhausted", "CHAR_BUDGET");
    }
    const lane = laneBudgets[spec.lane];
    if (lane && !lane.canSpend(need, now)) return refuse("laneBudgetExhausted", "LANE_BUDGET");
    return null;
  }

  function onToolCalls(spec, body, toolCalls, res, now) {
    const usage = res.json && res.json.usage && typeof res.json.usage === "object" ? res.json.usage.total_tokens : null;
    const tokens = Number.isSafeInteger(usage) && usage >= 0 ? usage : tokensOf(body);
    spend(spec.playerId, spec.lane, tokens, now);
    counters.ok += 1;
    breaker.success(now);
    const parsed = parseCompletion(res.json);
    return { ok: true, text: parsed.ok ? parsed.text : "", toolCalls, totalTokens: tokens };
  }

  function finishReasonOf(json) {
    const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
    const r = choice && typeof choice.finish_reason === "string" ? choice.finish_reason : null;
    return r === null ? null : r.replace(/[^\w:.\-]/g, "_").slice(0, 32);
  }

  function countReasoningTokens(json) {
    const usage = json && json.usage && typeof json.usage === "object" ? json.usage : null;
    const details = usage && usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
      ? usage.completion_tokens_details : null;
    const n = details ? details.reasoning_tokens : null;
    if (Number.isSafeInteger(n) && n >= 0) thinkCounters.reasoningTokens += n;
  }

  const withThinking = (out, think, res) => (think ? { ...out, thinking: true, finishReason: finishReasonOf(res.json) }
    : out);

  function onCompletion(spec, body, maxTokens, res, now, think) {
    if (think) countReasoningTokens(res.json);
    const toolCalls = hasTools(spec) ? parseToolCalls(res.json) : [];
    if (toolCalls.length > 0) return withThinking(onToolCalls(spec, body, toolCalls, res, now), think, res);
    const parsed = parseCompletion(res.json);
    if (!parsed.ok) {
      spend(spec.playerId, spec.lane, Number.isSafeInteger(parsed.totalTokens) ? parsed.totalTokens
        : tokensOf(body) + maxTokens, now);
      if (parsed.reason === "EMPTY") {
        counters.empty += 1;
        failed("EMPTY");
        breaker.success(now);
        if (think) {
          thinkCounters.empty += 1;
          if (finishReasonOf(res.json) === "length") thinkCounters.cut += 1;
          metric((t) => t.count(METRIC.thinkingEmpty, 1));
        }
        return withThinking({ ok: false, reason: "EMPTY" }, think, res);
      }
      counters.badShape += 1;
      failed("BAD_SHAPE");
      breaker.failure(now, null);
      return { ok: false, reason: "BAD_SHAPE" };
    }
    const tokens = parsed.totalTokens !== null ? parsed.totalTokens : tokensOf(body) + tokensOf(parsed.text);
    spend(spec.playerId, spec.lane, tokens, now);
    counters.ok += 1;
    breaker.success(now);
    return withThinking({ ok: true, text: parsed.text, toolCalls: null, totalTokens: tokens }, think, res);
  }

  function onFailure(spec, res, now, think) {
    const reason = res && typeof res.reason === "string" ? res.reason : "NET_ERROR";
    if (reason === "ABORTED") {
      breaker.release();
      return { ok: false, reason: "ABORTED" };
    }
    if (reason === "HTTP_STATUS") {
      const status = Number.isInteger(res.status) ? res.status : 0;
      const code = `HTTP_${status}`;
      if (status === 429) counters.http429 += 1;
      else if (status >= 400 && status < 500) counters.http4xx += 1;
      else if (status >= 500) counters.http5xx += 1;
      failed(code);
      if (status === HTTP_BAD_REQUEST && think) {
        breaker.release();
        thinkCounters.rejected += 1;
        if (!thinkingDisabled) {
          thinkingDisabled = true;
          log("shipAi client: thinking off - HTTP_400");
        }
        return { ok: false, reason: code, thinkingRejected: true };
      }
      if (status === HTTP_BAD_REQUEST && (hasTools(spec) || hasToolHistory(spec))) {
        breaker.release();
        return { ok: false, reason: code, toolsRejected: true };
      }
      if (HTTP_AUTH.includes(status)) {
        breaker.release();
        disable("AUTH_REJECTED");
      } else if (status >= 400 && status < 500 && !HTTP_RETRYABLE_4XX.includes(status)) {
        breaker.release();
        disable(code);
      } else {
        breaker.failure(now, Number.isFinite(res.retryAfterMs) ? res.retryAfterMs : null);
      }
      return { ok: false, reason: code };
    }
    const code = reason === "TIMEOUT" ? "TIMEOUT" : (reason === "TOO_LARGE" || reason === "BAD_JSON" ? "BAD_SHAPE"
      : "NET_ERROR");
    if (code === "TIMEOUT") counters.timeouts += 1;
    else if (code === "NET_ERROR") counters.netErrors += 1;
    else counters.badShape += 1;
    failed(code);
    breaker.failure(now, null);
    return { ok: false, reason: code };
  }

  function buildBody(spec, maxTokens, think) {
    const body = { ...(spec.extraBody && typeof spec.extraBody === "object" ? spec.extraBody : {}),
      model: S.model, messages: spec.messages, temperature: S.temperatureMilli / MILLI, top_p: S.topPMilli / MILLI,
      max_tokens: maxTokens, stream: false };
    if (think) {
      body.chat_template_kwargs = { enable_thinking: true };
      if (S.reasoningEffort !== "") body.reasoning_effort = S.reasoningEffort;
    } else if (S.reasoningOff === true) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    if (hasTools(spec)) {
      body.tools = spec.tools;
      body.tool_choice = spec.toolChoice === "none" ? "none" : "auto";
    }
    return JSON.stringify(body);
  }

  function request(spec) {
    try {
      if (!spec || !Number.isSafeInteger(spec.playerId) || spec.playerId <= 0 || !Array.isArray(spec.messages)
        || !LANES.includes(spec.lane)) {
        return Promise.resolve({ ok: false, reason: "BAD_INPUT" });
      }
      const now = nowMs();
      const think = Boolean(S) && spec.think === true && !thinkingDisabled;
      const maxTokens = think ? S.thinkingMaxTokens
        : (S && Number.isSafeInteger(spec.maxTokens) && spec.maxTokens > 0 ? spec.maxTokens : (S ? S.maxTokens : 0));
      const body = S ? buildBody(spec, maxTokens, think) : "";
      const refused = gate(spec, tokensOf(body) + maxTokens, now);
      if (refused) return Promise.resolve(refused);
      reqWindow.tryTake(now);
      if (spec.lane !== CHAT_LANE) bgWindow.tryTake(now);
      const controller = new AbortController();
      const entry = { controller };
      pending.add(entry);
      inFlight += 1;
      counters.requests += 1;
      metric((t) => t.count(METRIC.requests, 1));
      if (think) {
        thinkCounters.requests += 1;
        metric((t) => t.count(METRIC.thinkingRequests, 1));
      }
      if (spec.thinkingRetry === true) thinkCounters.retried += 1;
      let promise;
      try {
        if (transport === null) transport = d.transport && typeof d.transport.post === "function" ? d.transport
          : createDefaultChatTransport();
        promise = Promise.resolve(transport.post({ url, apiKey, body, timeoutMs: think ? S.thinkingTimeoutMs
          : S.timeoutMs, maxBytes: S.maxResponseBytes, signal: controller.signal }));
      } catch (_err) {
        promise = Promise.resolve({ ok: false, reason: "NET_ERROR" });
      }
      const settle = (res) => {
        try {
          pending.delete(entry);
          inFlight = Math.max(0, inFlight - 1);
          const at = nowMs();
          metric((t) => t.observe(METRIC.requestMs, Math.max(0, at - now)));
          if (state === STATE.STOPPED) return { ok: false, reason: "ABORTED" };
          return res && res.ok === true ? onCompletion(spec, body, maxTokens, res, at, think)
            : onFailure(spec, res, at, think);
        } catch (_err) {
          lastError = "RESULT_FAILED";
          try {
            breaker.failure(nowMs(), null);
          } catch (_e) {
          }
          return { ok: false, reason: "BAD_SHAPE" };
        }
      };
      return promise.then(settle, () => settle({ ok: false, reason: "NET_ERROR" }));
    } catch (_err) {
      return Promise.resolve({ ok: false, reason: "NET_ERROR" });
    }
  }

  function getStatus() {
    const now = nowMs();
    rollCharDay(now);
    const out = { state, breaker: breaker ? breaker.state(now) : BREAKER.CLOSED, inFlight,
      requestsLastMinute: reqWindow.inWindow(now), tokensToday: budget.usedToday(now),
      dailyTokenBudget: S ? S.dailyTokenBudget : 0, charactersToday: charUsed.size, model: S ? S.model : null, host,
      apiKeySet: apiKey !== "", counters: { ...counters },
      thinking: { chat: S ? S.thinkingChat === true : false, proactive: S ? S.thinkingProactive === true : false,
        disabled: thinkingDisabled, ...thinkCounters } };
    if (lastError !== null) out.lastError = lastError;
    return out;
  }

  function stop() {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    for (const entry of pending) {
      try {
        entry.controller.abort();
      } catch (_err) {
      }
    }
  }

  return Object.freeze({
    request,
    getStatus() {
      try {
        return getStatus();
      } catch (_err) {
        return { state, apiKeySet: apiKey !== "", host, lastError: "STATUS_FAILED" };
      }
    },
    stop,
  });
}

module.exports = { createShipAiClient, COUNTER_NAMES, STATE };
