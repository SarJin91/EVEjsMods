"use strict";

const RAISE_PATTERN = /RAISE\s*\(\s*(?:IGNORE|(?:ABORT|FAIL|ROLLBACK)\s*,\s*'(?:[^']|'')*')\s*\)/giu;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/gu, "\"\"")}"`;
}

function splitStatements(sql) {
  const out = [];
  let current = "";
  let quoted = false;
  for (const ch of String(sql)) {
    if (ch === "'") quoted = !quoted;
    if (ch === ";" && !quoted) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function triggerBody(triggerSql) {
  const text = String(triggerSql || "");
  const begin = /\sBEGIN\s/u.exec(text);
  const end = text.lastIndexOf("END");
  if (!begin || end <= begin.index) return null;
  return text.slice(begin.index + begin[0].length, end);
}

function childJoinPattern(recordsTable) {
  return new RegExp(`(^|[^A-Za-z_])((?:LEFT\\s+(?:OUTER\\s+)?)?)JOIN\\s+${escapeRegExp(recordsTable)}\\s+AS\\s+child\\s+ON\\b`, "gu");
}

function joinsRecordsAsChild(statement, recordsTable) {
  for (const match of statement.matchAll(childJoinPattern(recordsTable))) {
    if (!match[2]) return true;
  }
  return false;
}

function probeStatements(triggerSql, { recordsTable, key }) {
  const body = triggerBody(triggerSql);
  if (body === null) return [];
  const keyLiteral = `'${String(key).replace(/'/gu, "''")}'`;
  return splitStatements(body)
    .filter((statement) => joinsRecordsAsChild(statement, recordsTable))
    .map((statement) => statement
      .replace(RAISE_PATTERN, "1")
      .replace(/\bNEW\.key\b/gu, keyLiteral)
      .replace(/\bNEW\.json\b/gu, "@json"));
}

function namesIndex(detail, indexName) {
  return new RegExp(`INDEX ${escapeRegExp(indexName)}(\\s|$)`, "u").test(detail);
}

function statementPlanIsGood(lines, indexName) {
  const named = lines.filter((line) => namesIndex(line, indexName));
  return named.length > 0 && named.every((line) => /\bordinal=\?/u.test(line));
}

function explain(db, statement) {
  const prepared = db.prepare(`EXPLAIN QUERY PLAN ${statement}`);
  const rows = statement.includes("@json") ? prepared.all({ json: null }) : prepared.all();
  return rows.map((row) => String(row.detail));
}

function probeTriggerPlan(db, target) {
  const triggerSql = target.triggerSql !== undefined ? target.triggerSql : readTriggerSql(db, target.trigger);
  const statements = probeStatements(triggerSql, target);
  if (statements.length === 0) {
    return { ok: false, reason: "NO_PROBE", bad: 0, total: 0, detail: "no statement joins the records table" };
  }
  let bad = 0;
  try {
    for (const statement of statements) {
      if (!statementPlanIsGood(explain(db, statement), target.indexName)) bad += 1;
    }
  } catch (error) {
    return { ok: false, reason: "NO_PROBE", bad: 0, total: statements.length, detail: String(error && error.message) };
  }
  const reason = bad === 0 ? "GOOD" : "BAD";
  return { ok: reason === "GOOD", reason, bad, total: statements.length };
}

function readTriggerSql(db, trigger) {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(trigger);
  return row && typeof row.sql === "string" ? row.sql : null;
}

function findChildIndex(db, recordsTable, columns) {
  const indexes = db.prepare("SELECT name, \"unique\" AS isUnique FROM pragma_index_list(?)").all(recordsTable);
  const info = db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno");
  for (const index of indexes) {
    if (Number(index.isUnique) !== 1) continue;
    const names = info.all(index.name).map((row) => row.name);
    if (names.length === columns.length && names.every((name, position) => name === columns[position])) return index.name;
  }
  return null;
}

function resolveTarget(db, target) {
  const base = { recordsTable: target.recordsTable, trigger: target.trigger, key: target.key };
  const triggerSql = readTriggerSql(db, target.trigger);
  if (triggerSql === null) return { ok: false, reason: "NO_TRIGGER", ...base };
  const table = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?").get(target.recordsTable);
  if (!table) return { ok: false, reason: "NO_TABLE", ...base };
  const indexName = findChildIndex(db, target.recordsTable, target.columns);
  if (!indexName) return { ok: false, reason: "NO_INDEX", ...base };
  return { ok: true, reason: "OK", ...base, indexName, triggerSql };
}

module.exports = {
  probeStatements,
  probeTriggerPlan,
  quoteIdentifier,
  readTriggerSql,
  resolveTarget,
  splitStatements,
  triggerBody,
};
