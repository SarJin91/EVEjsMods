"use strict";

const path = require("node:path");
const { resolveConfig } = require("../config");
const S = require("../lib/shipAi/schema");
const { toolsFor } = require("../lib/shipAi/tools/catalog");
const { nativeToolsOf, parseToolCalls } = require("../lib/shipAi/tools/protocol");
const { createDefaultChatTransport } = require("../lib/chatterAi/transport");

const MOD_DIR = path.resolve(__dirname, "..");
const QUESTION = "How many jumps is it from here to Jita? Use a tool.";
const THINKING_QUESTION = "A freighter warps at 1.5 AU/s and a frigate at 5 AU/s. Over a 30 AU warp, how many "
  + "seconds does the frigate arrive before the freighter? Ignore acceleration. Answer in one short sentence.";
const COMPLETIONS_PATH = "/chat/completions";
const THINKING_FLAG = "--thinking";

const lengthOf = (v) => (typeof v === "string" ? v.length : 0);
const numberOf = (v) => (Number.isSafeInteger(v) ? String(v) : "-");

function thinkingShapeLines(json) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  const msg = choice && choice.message && typeof choice.message === "object" ? choice.message : {};
  const finish = choice && typeof choice.finish_reason === "string"
    ? choice.finish_reason.replace(/[^\w.\-]/g, "_").slice(0, 32) : "none";
  const content = typeof msg.content === "string" ? msg.content : "";
  const field = lengthOf(msg.reasoning) > 0 ? "reasoning" : (lengthOf(msg.reasoning_content) > 0
    ? "reasoning_content" : "none");
  const fieldLen = field === "none" ? 0 : lengthOf(msg[field]);
  const usage = json && json.usage && typeof json.usage === "object" ? json.usage : {};
  const details = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details : {};
  const out = [`finish_reason: ${finish}`,
    `content: ${content.trim() === "" ? "no" : "yes"} (${content.length} chars)`,
    `reasoning field: ${field} (${fieldLen} chars)`,
    `<think> in content: ${/<think>/i.test(content) ? "yes" : "no"}`,
    `usage: prompt=${numberOf(usage.prompt_tokens)} completion=${numberOf(usage.completion_tokens)} `
      + `total=${numberOf(usage.total_tokens)}`];
  if (Number.isSafeInteger(details.reasoning_tokens)) out.push(`reasoning_tokens: ${details.reasoning_tokens}`);
  return out;
}

async function probeThinking(M, key, transport, nowMs, log = console.log) {
  const body = { model: M.model, max_tokens: M.thinkingMaxTokens, stream: false,
    chat_template_kwargs: { enable_thinking: true },
    messages: [{ role: "system", content: "You are the onboard AI of a ship in New Eden." },
      { role: "user", content: THINKING_QUESTION }] };
  if (M.reasoningEffort !== "") body.reasoning_effort = M.reasoningEffort;
  const url = new URL(`${M.baseUrl.replace(/\/+$/, "")}${COMPLETIONS_PATH}`);
  const startedAt = nowMs();
  const res = await transport.post({ url, apiKey: key, body: JSON.stringify(body), timeoutMs: M.thinkingTimeoutMs,
    maxBytes: M.maxResponseBytes });
  const ms = Math.max(0, Math.round(nowMs() - startedAt));
  log(`shipAiToolProbe --thinking: model=${M.model} host=${url.host} max_tokens=${M.thinkingMaxTokens} `
    + `reasoning_effort=${M.reasoningEffort === "" ? "unset" : M.reasoningEffort}`);
  const status = res && Number.isInteger(res.status) ? res.status : "-";
  log(`shipAiToolProbe --thinking: HTTP ${status} time ${ms} ms`);
  if (!res || res.ok !== true) {
    log(`shipAiToolProbe --thinking: refused - ${String((res && res.reason) || "NET_ERROR")
      .replace(/[^\w]/g, "_")} (HTTP 400 = keep shipAi.thinkingChat / thinkingProactive off or unset reasoningEffort)`);
    return 1;
  }
  for (const line of thinkingShapeLines(res.json)) log(`shipAiToolProbe --thinking: ${line}`);
  return 0;
}

async function probeTools(M, key, transport, log = console.log) {
  const tools = nativeToolsOf(toolsFor(M));
  const body = { model: M.model, max_tokens: M.maxTokens, stream: false, tools,
    tool_choice: "auto", messages: [{ role: "system", content: "You are the onboard AI of a ship in New Eden." },
      { role: "user", content: QUESTION }] };
  if (M.reasoningOff === true) body.chat_template_kwargs = { enable_thinking: false };
  const url = new URL(`${M.baseUrl.replace(/\/+$/, "")}${COMPLETIONS_PATH}`);
  const res = await transport.post({ url, apiKey: key, body: JSON.stringify(body),
    timeoutMs: M.timeoutMs, maxBytes: M.maxResponseBytes });
  log(`shipAiToolProbe: model=${M.model} host=${url.host} tools=${tools.length}`);
  if (!res || res.ok !== true) {
    const status = res && Number.isInteger(res.status) ? ` HTTP ${res.status}` : "";
    log(`shipAiToolProbe: refused - ${String((res && res.reason) || "NET_ERROR").replace(/[^\w]/g, "_")}${status} `
      + "(HTTP 400 = the model refuses tools: keep shipAi.toolMode=text)");
    return 1;
  }
  const calls = parseToolCalls(res.json);
  if (calls.length > 0) {
    log(`shipAiToolProbe: tool_calls: yes (${calls.map((c) => c.name.replace(/[^\w]/g, "_")).join(", ")}) - `
      + "shipAi.toolMode=native may be set");
  } else {
    log("shipAiToolProbe: tool_calls: no - keep shipAi.toolMode=text");
  }
  return 0;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log || console.log;
  const resolved = resolveConfig({ env: deps.env || process.env, modDir: MOD_DIR });
  const parsed = S.shipAiModelSettingsOf(resolved.config);
  if (!parsed.ok) {
    log(`shipAiToolProbe: settings refused - ${parsed.detail}`);
    return 1;
  }
  const M = parsed.settings;
  const key = S.apiKeyOf(resolved.config).key;
  if (key === "") {
    log("shipAiToolProbe: no API key (EVEJS_LNE_SHIP_AI_API_KEY or EVEJS_LNE_CHATTER_AI_API_KEY)");
    return 1;
  }
  const transport = deps.transport || createDefaultChatTransport();
  if (argv.includes(THINKING_FLAG)) return probeThinking(M, key, transport, deps.nowMs || (() => Date.now()), log);
  return probeTools(M, key, transport, log);
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }, (err) => {
    console.log(`shipAiToolProbe: failed - ${String((err && err.code) || (err && err.name) || "error")}`);
    process.exitCode = 1;
  });
}

module.exports = { main, thinkingShapeLines, probeThinking, probeTools };
