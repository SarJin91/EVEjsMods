"use strict";

const { performance } = require("node:perf_hooks");
const { toolsFor, toolMapFor, catalogueLines } = require("./catalog");
const { parseAsk, nativeToolsOf, TEXT_ARG } = require("./protocol");
const { TOOL_RULE, TOOL_RULE_PROACTIVE, ANSWER_NOW } = require("../data/persona");
const { sanitizeGameText } = require("../context");
const { METRIC } = require("../schema");

const CACHE_PER_CHARACTER = 32;
const MAX_STRING_CHARS = 100;
const TOOL_STATUS = Object.freeze({ OK: "ok", REFUSED: "refused" });

const isObj = (v) => Boolean(v) && typeof v === "object";
const codeOf = (value) => String(value ?? "unknown").replace(/[^\w:.\-]/g, "_").slice(0, 60);

function cleanDeep(value) {
  if (typeof value === "string") return sanitizeGameText(value, MAX_STRING_CHARS);
  if (Array.isArray(value)) return value.map(cleanDeep);
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanDeep(v)]));
  return value === undefined ? null : value;
}

function fitResult(result, max) {
  const value = cleanDeep(result);
  let json = JSON.stringify(value);
  const lists = () => {
    const out = [];
    const walk = (v) => {
      if (Array.isArray(v)) out.push(v);
      if (isObj(v)) Object.values(v).forEach(walk);
    };
    walk(value);
    return out.filter((l) => l.length > 0);
  };
  while (json.length > max) {
    const longest = lists().sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!longest) return JSON.stringify({ ok: false, reason: "RESULT_TOO_LARGE" });
    longest.pop();
    json = JSON.stringify(value);
  }
  return json;
}

function argsFor(tool, raw) {
  if (raw === null || !isObj(raw)) return { ok: false, reason: "BAD_ARGUMENT" };
  const names = Object.keys(tool.args);
  const source = TEXT_ARG in raw && names.length > 0 ? { [names[0]]: raw[TEXT_ARG] } : raw;
  const args = {};
  for (const name of names) {
    const spec = tool.args[name];
    const v = source[name];
    if (spec.optional === true && typeof spec.default === "string"
      && (v === undefined || v === null || (typeof v === "string" && v.trim() === ""))) {
      args[name] = spec.default;
      continue;
    }
    if (typeof v !== spec.type || v.trim() === "" || v.length > spec.maxLen) return { ok: false, reason: "BAD_ARGUMENT" };
    args[name] = v.trim();
  }
  return { ok: true, args };
}

function withToolRule(messages, mode, S, rule) {
  const lines = (rule === "proactive" ? TOOL_RULE_PROACTIVE : TOOL_RULE)[mode] || [];
  const text = lines.join("\n").replace("{max}", String(S.toolCallsPerRound))
    .replace("{tools}", catalogueLines(toolsFor(S)));
  const at = messages.findIndex((m) => m.role !== "system");
  const i = at < 0 ? messages.length : at;
  return [...messages.slice(0, i), { role: "system", content: text }, ...messages.slice(i)];
}

function createToolState(S) {
  const byTool = Object.fromEntries(toolsFor(S).map((t) => [t.name, { ok: 0, refused: 0 }]));
  return { mode: S.toolMode, cache: new Map(),
    counters: { answers: 0, rounds: 0, calls: 0, unknownTool: 0, badArgument: 0, budgetRefused: 0, cacheHits: 0,
      nativeRejected: 0, tooManyCalls: 0, failed: 0, dbReadSlow: 0, thinkingRetried: 0, thinkingFinalAsked: 0 },
    byTool };
}

function countTool(st, name, status) {
  if (!st.byTool[name]) st.byTool[name] = { ok: 0, refused: 0 };
  st.byTool[name][status] += 1;
}

function cacheGet(st, playerId, key, now, ttl) {
  const m = st.cache.get(playerId);
  const hit = m ? m.get(key) : undefined;
  if (!hit) return null;
  m.delete(key);
  if (now - hit.at >= ttl) return null;
  m.set(key, hit);
  return hit.json;
}

function cachePut(st, playerId, key, json, now) {
  let m = st.cache.get(playerId);
  if (!m) {
    m = new Map();
    st.cache.set(playerId, m);
  }
  m.delete(key);
  m.set(key, { at: now, json });
  while (m.size > CACHE_PER_CHARACTER) m.delete(m.keys().next().value);
}

async function runCalls(calls, o) {
  const { S, ctx, st, perfNow, metric } = o;
  const byName = toolMapFor(S);
  const startedAt = perfNow();
  const out = [];
  for (const call of calls) {
    st.counters.calls += 1;
    metric(METRIC.toolCalls);
    const tool = byName.get(call.name);
    let result;
    let key = null;
    if (!tool) {
      st.counters.unknownTool += 1;
      result = { ok: false, reason: "UNKNOWN_TOOL" };
    } else if (perfNow() - startedAt > S.toolBudgetMs) {
      st.counters.budgetRefused += 1;
      result = { ok: false, reason: "TOOL_BUDGET" };
    } else {
      const a = argsFor(tool, call.args);
      if (!a.ok) {
        st.counters.badArgument += 1;
        result = a;
      } else {
        key = `${tool.name}|${JSON.stringify(a.args)}`;
        const cached = S.toolCacheMs > 0 ? cacheGet(st, ctx.playerId, key, ctx.nowMs(), S.toolCacheMs) : null;
        if (cached !== null) {
          st.counters.cacheHits += 1;
          countTool(st, tool.name, TOOL_STATUS.OK);
          out.push(cached);
          continue;
        }
        const calledAt = tool.db === true ? perfNow() : 0;
        try {
          result = await tool.run({ ...ctx, S }, a.args);
        } catch (_err) {
          result = { ok: false, reason: "TOOL_FAILED" };
        }
        if (tool.db === true && perfNow() - calledAt > S.dbReadSlowMs) {
          st.counters.dbReadSlow += 1;
          metric(METRIC.dbReadSlow);
        }
        if (!isObj(result) || typeof result.ok !== "boolean") result = { ok: false, reason: "TOOL_FAILED" };
      }
    }
    const json = fitResult(result, S.toolResultMaxChars);
    if (tool) countTool(st, tool.name, result.ok ? TOOL_STATUS.OK : TOOL_STATUS.REFUSED);
    if (result.ok && key !== null && S.toolCacheMs > 0) cachePut(st, ctx.playerId, key, json, ctx.nowMs());
    out.push(json);
  }
  return out;
}

const TOOL_RESULT_RE = /^[\s>*\-`]*TOOL_RESULT\b/i;

function thinkingOff(client) {
  try {
    const t = typeof client.getStatus === "function" ? client.getStatus().thinking : null;
    return Boolean(t) && t.disabled === true;
  } catch (_err) {
    return false;
  }
}

function finalOf(res) {
  const text = parseAsk(res.text, Number.MAX_SAFE_INTEGER).rest.split("\n")
    .filter((l) => !TOOL_RESULT_RE.test(l)).join("\n").trim();
  if (text === "") return { ok: false, reason: "EMPTY" };
  return { ok: true, text, toolCalls: null, totalTokens: res.totalTokens };
}

async function runToolLoop(o) {
  const { client, S, ctx } = o;
  const st = o.state || createToolState(S);
  const maxRounds = Number.isSafeInteger(o.maxRounds) && o.maxRounds >= 0 ? o.maxRounds : S.toolMaxRounds;
  const rule = o.rule === "proactive" ? "proactive" : "chat";
  const perfNow = typeof o.perfNow === "function" ? o.perfNow : () => performance.now();
  const telemetry = o.telemetry && typeof o.telemetry.count === "function" ? o.telemetry : null;
  const metric = (name) => {
    try {
      if (telemetry) telemetry.count(name, 1);
    } catch (_err) {
    }
  };
  try {
    let mode = o.mode === "native" ? "native" : "text";
    let prompt = withToolRule(o.messages, mode, S, rule);
    const history = [];
    let rounds = 0;
    let switched = false;
    let thinkRejectedRetry = false;
    let noThinkRound = false;
    let retryNow = false;
    let unthought = null;
    st.counters.answers += 1;
    for (;;) {
      const last = rounds >= maxRounds || unthought !== null;
      const messages = [...prompt, ...history.flatMap((h) => h[mode])];
      const spec = { playerId: ctx.playerId, lane: o.lane || "chat", maxTokens: o.maxTokens,
        messages: last ? [...messages, { role: "system", content: ANSWER_NOW }] : messages };
      if (mode === "native") {
        spec.tools = nativeToolsOf(toolsFor(S));
        if (last) spec.toolChoice = "none";
      }
      if (o.think === true && !noThinkRound && (last || S.thinkingToolRounds === true)) spec.think = true;
      if (retryNow) {
        spec.thinkingRetry = true;
        retryNow = false;
      }
      const res = await client.request(spec);
      if (unthought !== null && (!res || res.ok !== true)) return finalOf(unthought);
      if (res && res.ok !== true && res.thinkingRejected === true && !thinkRejectedRetry) {
        thinkRejectedRetry = true;
        continue;
      }
      if (res && res.ok !== true && res.reason === "EMPTY" && res.thinking === true && o.retryEmpty === true
        && !noThinkRound) {
        noThinkRound = true;
        retryNow = true;
        st.counters.thinkingRetried += 1;
        continue;
      }
      if (!res || res.ok !== true) {
        if (res && res.toolsRejected === true && mode === "native" && !switched) {
          switched = true;
          st.counters.nativeRejected += 1;
          st.mode = "text";
          mode = "text";
          prompt = withToolRule(o.messages, mode, S, rule);
          continue;
        }
        st.counters.failed += 1;
        return res || { ok: false, reason: "NET_ERROR" };
      }
      const calls = mode === "native" ? (Array.isArray(res.toolCalls) ? res.toolCalls : [])
        : parseAsk(res.text, S.toolCallsPerRound).calls;
      if (!last && calls.length === 0 && o.think === true && spec.think !== true && !noThinkRound
        && !thinkingOff(client)) {
        unthought = res;
        st.counters.thinkingFinalAsked += 1;
        continue;
      }
      if (last || calls.length === 0) {
        const final = finalOf(res);
        return !final.ok && unthought !== null ? finalOf(unthought) : final;
      }
      rounds += 1;
      st.counters.rounds += 1;
      noThinkRound = false;
      const run = calls.slice(0, S.toolCallsPerRound);
      const results = await runCalls(run, { S, ctx, st, perfNow, metric });
      const asText = (lines) => [{ role: "assistant", content: lines.join("\n") },
        { role: "user", content: run.map((c, i) => `TOOL_RESULT ${c.name}: ${results[i]}`).join("\n") }];
      if (mode === "native") {
        const extra = calls.slice(S.toolCallsPerRound);
        st.counters.tooManyCalls += extra.length;
        history.push({ native: [
          { role: "assistant", content: String(res.text || ""), tool_calls: calls.map((c) => ({ id: c.id,
            type: "function", function: { name: c.name, arguments: c.rawArgs } })) },
          ...run.map((c, i) => ({ role: "tool", tool_call_id: c.id, content: results[i] })),
          ...extra.map((c) => ({ role: "tool", tool_call_id: c.id,
            content: JSON.stringify({ ok: false, reason: "TOO_MANY_CALLS" }) }))],
        text: asText(run.map((c) => `ASK: ${c.name} ${c.rawArgs || "{}"}`)) });
      } else {
        history.push({ text: asText(run.map((c) => c.line)) });
      }
    }
  } catch (err) {
    st.counters.failed += 1;
    return { ok: false, reason: "BAD_SHAPE", detail: codeOf(err && (err.code || err.name)) };
  }
}

function createToolRunner(o) {
  const st = createToolState(o.S);
  let stopped = false;
  async function direct(spec) {
    const think = spec.lane === "chat" ? o.S.thinkingChat === true
      : spec.lane === "proactive" && o.S.thinkingProactive === true;
    if (!think) return o.client.request(spec);
    try {
      const res = await o.client.request({ ...spec, think: true });
      if (res && res.ok !== true && res.thinkingRejected === true) return await o.client.request(spec);
      if (res && res.ok !== true && res.reason === "EMPTY" && res.thinking === true && spec.lane === "chat"
        && o.S.thinkingRetryEmpty === true) {
        st.counters.thinkingRetried += 1;
        return await o.client.request({ ...spec, thinkingRetry: true });
      }
      return res;
    } catch (_err) {
      return { ok: false, reason: "NET_ERROR" };
    }
  }
  const plain = (spec) => {
    if (!spec || !("tools" in spec)) return spec;
    const { tools: _flag, ...rest } = spec;
    return rest;
  };
  const loopOf = (spec, more) => runToolLoop({ client: o.client, messages: spec.messages, mode: st.mode, S: o.S,
    state: st, lane: spec.lane, maxTokens: spec.maxTokens, perfNow: o.perfNow, telemetry: o.telemetry,
    ctx: { playerId: spec.playerId, deps: o.deps, nowMs: o.nowMs }, ...more });
  function request(spec) {
    const running = !stopped && st.mode !== "off" && Boolean(spec);
    if (running && spec.lane === "chat") {
      return loopOf(spec, { think: o.S.thinkingChat === true, retryEmpty: o.S.thinkingRetryEmpty === true });
    }
    if (running && spec.lane === "proactive" && spec.tools === true) {
      return loopOf(spec, { maxRounds: o.S.proactiveToolMaxRounds, rule: "proactive",
        think: o.S.thinkingProactive === true, retryEmpty: false });
    }
    const out = plain(spec);
    return out && (out.lane === "chat" || out.lane === "proactive") ? direct(out) : o.client.request(out);
  }
  return Object.freeze({
    request,
    getStatus: () => ({ mode: st.mode, counters: { ...st.counters },
      byTool: Object.fromEntries(Object.entries(st.byTool).map(([k, v]) => [k, { ...v }])) }),
    stop() {
      stopped = true;
      st.cache.clear();
    },
  });
}

module.exports = { runToolLoop, createToolRunner, createToolState, argsFor, fitResult, withToolRule };
