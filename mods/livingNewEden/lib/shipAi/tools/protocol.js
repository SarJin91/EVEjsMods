"use strict";

const MAX_ARGS_CHARS = 512;
const MAX_NAME_CHARS = 32;
const MAX_ID_CHARS = 64;
const MAX_LINE_CHARS = 600;
const ASK_RE = /^ASK:\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+([\s\S]*))?$/i;
const EDGE_MARKS_RE = /^[`*\-\s]+|[`*\s]+$/g;
const TEXT_ARG = "$text";

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function argsOf(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return {};
  if (text.length > MAX_ARGS_CHARS) return null;
  if (!text.startsWith("{")) return { [TEXT_ARG]: text };
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch (_err) {
    return null;
  }
}

function askOf(rawLine) {
  const line = String(rawLine).replace(EDGE_MARKS_RE, "");
  const m = ASK_RE.exec(line);
  if (!m || m[1].length > MAX_NAME_CHARS) return null;
  return { name: m[1].toLowerCase(), args: argsOf(m[2]), line: line.slice(0, MAX_LINE_CHARS) };
}

function parseAsk(text, max) {
  const lines = String(text ?? "").split(/\r?\n/);
  const limit = Number.isSafeInteger(max) && max > 0 ? max : 1;
  const calls = [];
  let i = 0;
  for (; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    const ask = askOf(lines[i]);
    if (!ask) break;
    if (calls.length < limit) calls.push(ask);
  }
  const rest = lines.slice(i).filter((l) => askOf(l) === null).join("\n").trim();
  return { calls, rest };
}

function nativeToolsOf(tools) {
  return tools.map((t) => {
    const names = Object.keys(t.args);
    const properties = Object.fromEntries(names.map((n) => [n, { type: t.args[n].type,
      maxLength: t.args[n].maxLen }]));
    return { type: "function", function: { name: t.name, description: t.description,
      parameters: { type: "object", properties, required: names.filter((n) => t.args[n].optional !== true) } } };
  });
}

function parseToolCalls(json) {
  const choices = json && typeof json === "object" ? json.choices : null;
  const message = Array.isArray(choices) && choices[0] && typeof choices[0] === "object" ? choices[0].message : null;
  const list = message && typeof message === "object" ? message.tool_calls : null;
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((call, i) => {
    const fn = call && typeof call === "object" ? call.function : null;
    if (!fn || typeof fn !== "object" || typeof fn.name !== "string") return;
    const id = typeof call.id === "string" && call.id !== "" && call.id.length <= MAX_ID_CHARS ? call.id : `call_${i}`;
    const rawArgs = typeof fn.arguments === "string" ? fn.arguments : (isPlainObject(fn.arguments)
      ? JSON.stringify(fn.arguments) : "");
    const args = rawArgs.length > MAX_ARGS_CHARS ? null : argsOf(rawArgs === "" ? "{}" : rawArgs);
    out.push({ id, name: fn.name.slice(0, MAX_NAME_CHARS).toLowerCase(), args: args && TEXT_ARG in args ? null : args,
      rawArgs: rawArgs.slice(0, MAX_ARGS_CHARS) });
  });
  return out;
}

module.exports = { parseAsk, nativeToolsOf, parseToolCalls, TEXT_ARG, MAX_ARGS_CHARS };
