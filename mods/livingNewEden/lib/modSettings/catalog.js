"use strict";

const MASK = "***";
const MAX_QUERY_CHARS = 64;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function sameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function shown(value, secret) {
  if (secret) return MASK;
  return value === undefined ? null : value;
}

function matches(row, q) {
  if (q === "") return true;
  return [row.key, row.label, row.description, row.env].some((t) => typeof t === "string" && t.toLowerCase().includes(q));
}

function intIn(value, min, max, fallback) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function describeRows(provider, state, query) {
  const all = provider.rows();
  const running = isPlainObject(state && state.running) ? state.running : {};
  const next = state && state.next && isPlainObject(state.next.values) ? state.next : { values: {}, sources: {} };
  const under = state && state.underlying && isPlainObject(state.underlying.values) ? state.underlying
    : { values: {}, sources: {} };
  const overrides = isPlainObject(state && state.overrides) ? state.overrides : {};
  const q = typeof (query && query.q) === "string" ? query.q.trim().toLowerCase().slice(0, MAX_QUERY_CHARS) : "";
  const group = typeof (query && query.group) === "string" && query.group !== "" ? query.group : null;
  const exact = typeof (query && query.key) === "string" ? query.key : null;
  const maxRows = query.maxRowsPerPage;
  const offset = intIn(query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = intIn(query.limit, 1, maxRows, maxRows);

  const counts = new Map();
  for (const row of all) counts.set(row.group, (counts.get(row.group) || 0) + 1);
  const groups = [...counts.keys()].sort().map((g) => ({ group: g, count: counts.get(g) }));

  const picked = all.filter((row) => (group === null || row.group === group) && (exact === null || row.key === exact)
    && matches(row, q));
  const rows = picked.slice(offset, offset + limit).map((row) => {
    const secret = row.secret === true;
    const lock = provider.locked(row.key);
    const hasOverride = hasOwn(overrides, row.key);
    const out = { key: row.key, label: row.label, description: row.description, group: row.group, type: row.type,
      default: shown(row.default, secret) };
    for (const field of ["min", "max", "step", "values"]) if (row[field] !== undefined) out[field] = row[field];
    Object.assign(out, {
      env: row.env,
      source: typeof next.sources[row.key] === "string" ? next.sources[row.key] : null,
      running: shown(running[row.key], secret),
      next: shown(next.values[row.key], secret),
      hasOverride,
      override: hasOverride ? shown(overrides[row.key], secret) : null,
      underlying: shown(under.values[row.key], secret),
      underlyingSource: typeof under.sources[row.key] === "string" ? under.sources[row.key] : null,
      locked: lock.locked === true,
      lockReason: lock.locked === true ? lock.reason : null,
      apply: provider.apply(row.key),
      pending: !sameValue(next.values[row.key], running[row.key]),
    });
    return out;
  });
  return { ok: true, modId: provider.modId, rows, groups, total: picked.length, offset, limit };
}

function redactRowMessages(messages, rows) {
  if (!Array.isArray(messages)) return [];
  const secrets = rows.filter((row) => row.secret === true);
  return messages.map((m) => {
    const text = String(m);
    const hit = secrets.find((row) => text.includes(row.key) || (typeof row.env === "string" && row.env !== ""
      && text.includes(row.env)));
    return hit ? `<redacted: ${hit.key}>` : text;
  });
}

module.exports = { MASK, describeRows, redactRowMessages };
