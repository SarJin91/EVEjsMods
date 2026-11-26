"use strict";

const STATUS = Object.freeze({ OK: "ok", DRIFT: "DRIFT", MISSING: "MISSING" });

function hasOwn(value, property) {
  return value !== null && (typeof value === "object" || typeof value === "function")
    && Object.prototype.hasOwnProperty.call(value, property);
}

function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function symbolPresent(exportsObject, symbol) {
  const name = symbol.name;
  switch (symbol.kind) {
    case "export":
      return hasOwn(exportsObject, name) && typeof exportsObject[name] === (symbol.valueType || "function");
    case "method":
      return isObjectLike(exportsObject) && typeof exportsObject[name] === "function";
    case "prototypeMethod": {
      if (!isObjectLike(exportsObject)) return false;
      const proto = Object.getPrototypeOf(exportsObject);
      return hasOwn(proto, name) && typeof proto[name] === "function";
    }
    case "classPrototypeMethod": {
      const cls = symbol.classExport ? (isObjectLike(exportsObject) ? exportsObject[symbol.classExport] : undefined)
        : exportsObject;
      return typeof cls === "function" && isObjectLike(cls.prototype)
        && hasOwn(cls.prototype, name) && typeof cls.prototype[name] === "function";
    }
    case "property":
      return hasOwn(exportsObject, name);
    default:
      return false;
  }
}

function safeLoad(access, path) {
  try {
    const result = access.load(path);
    if (result && result.ok === true) return result;
    return { ok: false, reason: (result && result.reason) || "load_failed" };
  } catch (err) {
    return { ok: false, reason: `require_failed: ${(err && err.message) || err}` };
  }
}

function safePresent(exportsObject, symbol) {
  try {
    return symbolPresent(exportsObject, symbol);
  } catch (_err) {
    return false;
  }
}

function probeModules(table, access) {
  const modules = [];
  const counts = { ok: 0, drift: 0, missing: 0 };
  const disabledModules = {};
  for (const entry of Array.isArray(table) ? table : []) {
    const symbols = Array.isArray(entry.symbols) ? entry.symbols : [];
    const loaded = safeLoad(access, entry.path);
    const failed = loaded.ok ? symbols.filter((s) => !safePresent(loaded.exports, s)) : symbols;
    const affects = [];
    for (const s of failed) {
      for (const consumer of s.consumers || []) {
        if (!affects.includes(consumer)) affects.push(consumer);
        if (!hasOwn(disabledModules, consumer)) {
          disabledModules[consumer] = loaded.ok ? `drift:${entry.path}.${s.name}` : `missing:${entry.path}`;
        }
      }
    }
    let status = STATUS.OK;
    if (!loaded.ok) status = STATUS.MISSING;
    else if (failed.length > 0) status = STATUS.DRIFT;
    counts[status === STATUS.OK ? "ok" : status === STATUS.DRIFT ? "drift" : "missing"] += 1;
    modules.push({
      path: entry.path,
      status,
      missing: failed.map((s) => s.name),
      reason: loaded.ok ? null : loaded.reason,
      affects,
    });
  }
  return { modules, passed: counts.drift === 0 && counts.missing === 0, counts, disabledModules };
}

function formatProbeLog(report) {
  const counts = report.counts || { ok: 0, drift: 0, missing: 0 };
  const suffix = report.error ? ` - ${report.error}` : "";
  const tally = `${counts.ok} ok, ${counts.drift} drift, ${counts.missing} missing`;
  const lines = [`probe ${report.passed ? "passed" : "failed"} (${tally})${suffix}`];
  for (const m of report.modules || []) {
    if (m.status === STATUS.OK) continue;
    const affects = `(affects: ${(m.affects && m.affects.length > 0) ? m.affects.join(", ") : "none"})`;
    if (m.status === STATUS.DRIFT) lines.push(`probe DRIFT ${m.path} - missing ${m.missing.join(", ")} ${affects}`);
    else lines.push(`probe MISSING ${m.path} - ${m.reason} ${affects}`);
  }
  return lines;
}

module.exports = { STATUS, symbolPresent, probeModules, formatProbeLog };
