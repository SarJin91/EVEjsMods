"use strict";

const { ENV_PREFIX, SCHEMA, TYPE_PARSERS } = require("../../config");

const ENTRY_RE = /^(\s+)([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*?))?\s*$/;
const KEY_LINE_RE = /^(\s*)([A-Za-z0-9_.-]+):(?:\s+(.*?))?\s*$/;
const DEFAULT_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*):-([^${}]*)\}$/;
const DQ_RE = /^"([^"\\]*)"(?:\s+#.*)?$/;
const SQ_RE = /^'([^']*)'(?:\s+#.*)?$/;

function refusal(detail) {
  return { ok: false, reason: "ARGS_INVALID", detail: String(detail) };
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isSkippable(line) {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

function scalarOf(key, raw) {
  const text = raw === undefined ? "" : raw;
  let scalar;
  if (text.startsWith("\"") || text.startsWith("'")) {
    const m = DQ_RE.exec(text) || SQ_RE.exec(text);
    if (!m) return { ok: false, detail: "a quoted value of an unknown shape" };
    scalar = m[1];
  } else {
    scalar = text.replace(/\s+#.*$/, "");
  }
  if (scalar === "") return { ok: false, detail: "an empty value (the shell variable) is not a known shape" };
  if (!scalar.includes("$")) return { ok: true, value: scalar, fixed: true };
  const m = DEFAULT_RE.exec(scalar);
  if (!m || m[1] !== key) return { ok: false, detail: `${scalar} is not \${${key}:-default}` };
  return { ok: true, value: m[2], fixed: false };
}

function parseComposeEnv(text, opts = {}) {
  const prefix = opts.prefix || ENV_PREFIX;
  if (typeof text !== "string") return refusal("compose: no text");
  const lines = text.split(/\r?\n/);
  const at = (i) => `compose line ${i + 1}`;
  const servicesAt = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l));
  if (servicesAt < 0) return refusal("compose: no top-level services:");
  const found = [];
  let serviceIndent = null;
  let service = null;
  let childIndent = null;
  for (let i = servicesAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isSkippable(line)) continue;
    const ind = indentOf(line);
    if (ind === 0) break;
    if (line.includes("\t")) return refusal(`${at(i)}: a tab`);
    if (serviceIndent === null) serviceIndent = ind;
    if (ind < serviceIndent) return refusal(`${at(i)}: indent below the services`);
    if (ind === serviceIndent) {
      const m = KEY_LINE_RE.exec(line);
      if (!m || m[3]) return refusal(`${at(i)}: a service name of an unknown shape`);
      service = { name: m[2], values: {}, keys: 0, fixed: 0, seen: new Set(), entries: [] };
      found.push(service);
      childIndent = null;
      continue;
    }
    if (childIndent === null) childIndent = ind;
    if (ind !== childIndent) continue;
    const m = KEY_LINE_RE.exec(line);
    if (!m || m[2] !== "environment") continue;
    if (m[3]) {
      if (m[3].includes(prefix)) return refusal(`${at(i)}: environment of service ${service.name} in flow form`);
      continue;
    }
    let entryIndent = null;
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const el = lines[j];
      if (isSkippable(el)) continue;
      const eind = indentOf(el);
      if (eind <= childIndent) break;
      if (entryIndent === null) entryIndent = eind;
      const trimmed = el.trim();
      if (trimmed.startsWith("- ")) {
        if (trimmed.includes(prefix)) return refusal(`${at(j)}: environment of service ${service.name} in list form`);
        continue;
      }
      const em = eind === entryIndent ? ENTRY_RE.exec(el) : null;
      if (!em) {
        if (el.includes(prefix)) return refusal(`${at(j)}: an environment line of an unknown shape`);
        continue;
      }
      const key = em[2];
      if (!key.startsWith(prefix)) continue;
      if (service.seen.has(key)) return refusal(`${at(j)}: ${key} twice in service ${service.name}`);
      service.seen.add(key);
      const sc = scalarOf(key, em[3]);
      if (!sc.ok) return refusal(`${at(j)}: ${key}: ${sc.detail}`);
      service.keys += 1;
      if (sc.fixed) service.fixed += 1;
      service.entries.push(Object.freeze({ name: key, value: sc.value, fixed: sc.fixed }));
      if (sc.value.trim() !== "") service.values[key] = sc.value;
    }
    i = j - 1;
  }
  const withLne = found.filter((s) => s.keys > 0);
  if (withLne.length === 0) return refusal(`compose: no service with ${prefix}* in environment:`);
  if (withLne.length > 1) {
    return refusal(`compose: ${prefix}* in more than one service (${withLne.map((s) => s.name).join(", ")})`);
  }
  const s = withLne[0];
  return { ok: true, service: s.name, values: Object.freeze({ ...s.values }), keys: s.keys, fixed: s.fixed,
    entries: Object.freeze([...s.entries]) };
}

function compareWithSchema(values, schema = SCHEMA) {
  const differ = [];
  const unknown = [];
  const invalid = [];
  for (const [env, raw] of Object.entries(values || {})) {
    const row = schema.find((r) => r.env === env);
    if (!row) {
      unknown.push(env);
      continue;
    }
    const parser = TYPE_PARSERS[row.type];
    const parsed = parser ? parser.fromString(String(raw).trim()) : { ok: false };
    if (!parsed.ok) invalid.push(env);
    else if (JSON.stringify(parsed.value) !== JSON.stringify(row.default)) differ.push(row.key);
  }
  return { differ, unknown, invalid };
}

module.exports = { parseComposeEnv, compareWithSchema };
