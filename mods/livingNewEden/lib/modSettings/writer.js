"use strict";

const { IGNORE_ENV, OVERRIDE_SCHEMA_VERSION, overridePathOf, readOverrideFile, writeOverrideFileAtomic } =
  require("./overrideFile");
const { MASK, redactRowMessages } = require("./catalog");

const COUNTER_NAMES = Object.freeze(["writes", "writeRejected", "resets", "auditFailed", "liveApplied"]);
const SOURCE_OVERRIDE = "override";
const APPLY_FALLBACK = "restart";
const APPLY_LIVE = "live";
const SUMMARY_RE = /^\d+ keys overridden in game \(/;
const MAX_DETAIL = 200;
const MAX_NAME_CHARS = 64;
const MAX_CHANNEL_CHARS = 16;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function jsonOf(value) {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function clip(text) {
  return String(text).replace(CONTROL_RE, " ").slice(0, MAX_DETAIL);
}

function actorOf(actor) {
  const a = isPlainObject(actor) ? actor : {};
  return {
    characterId: Number.isSafeInteger(a.characterId) && a.characterId > 0 ? a.characterId : null,
    characterName: typeof a.characterName === "string" ? a.characterName.replace(CONTROL_RE, " ").slice(0,
      MAX_NAME_CHARS) : null,
    channel: typeof a.channel === "string" ? a.channel.replace(CONTROL_RE, " ").slice(0, MAX_CHANNEL_CHARS) : null,
  };
}

function createWriter(deps) {
  const env = deps.env || process.env;
  const nowMs = deps.clock && typeof deps.clock.now === "function" ? () => deps.clock.now() : () => Date.now();
  const audit = deps.audit || null;
  const telemetry = deps.telemetry || null;
  const log = typeof deps.log === "function" ? deps.log : () => {};

  function count(name) {
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`modSettings.${name}`, 1);
    } catch (_err) {
    }
  }

  function refuse(reason, detail, extra) {
    count("writeRejected");
    return { ok: false, reason, ...(detail !== undefined ? { detail: clip(detail) } : {}), ...(extra || {}) };
  }

  function providerOf(modId) {
    const entry = typeof modId === "string" ? deps.entryOf(modId) : null;
    if (!entry) return { refusal: refuse("UNKNOWN_MOD") };
    if (!entry.provider) return { refusal: refuse("NO_PROVIDER", entry.reason || undefined) };
    const rows = entry.provider.rows();
    return { entry, provider: entry.provider, rows, keys: new Set(rows.map((r) => r.key)) };
  }

  function fileOf(provider) {
    const filePath = overridePathOf(provider.dataDir);
    const file = readOverrideFile(filePath, {});
    if (file.present && file.warnings.length > 0) {
      return { refusal: refuse("WRITE_FAILED", `the override file is broken - fix or delete it (${file.warnings[0]})`) };
    }
    return { filePath, file };
  }

  function staleOf(file, expectedRevision) {
    if (Number.isSafeInteger(expectedRevision) && expectedRevision === file.revision) return null;
    return refuse("STALE_REVISION", `the file is at revision ${file.revision}`, { revision: file.revision });
  }

  function freshOf(after, before) {
    return after.filter((m) => !before.includes(m) && !SUMMARY_RE.test(m));
  }

  function pendingOf(entry, key, next) {
    const running = isPlainObject(entry.running) ? entry.running : {};
    return jsonOf(next.values[key]) !== jsonOf(running[key]);
  }

  function noopOf(p, revision, key, before) {
    let apply = p.provider.apply(key);
    let pending = pendingOf(p.entry, key, before);
    const warnings = [];
    if (pending && apply === APPLY_LIVE) {
      let live;
      try {
        live = typeof deps.applyLive === "function"
          ? deps.applyLive({ entry: p.entry, modId: p.provider.modId, key, after: before })
          : { ok: false, reason: "NOT_LIVE" };
      } catch (err) {
        live = { ok: false, reason: "APPLY_FAILED", detail: (err && err.message) || err };
      }
      if (live && live.ok === true && Array.isArray(live.applied) && live.applied.includes(key)) {
        count("liveApplied");
        pending = false;
      } else {
        apply = APPLY_FALLBACK;
        warnings.push(`the live apply failed again (${clip(`${(live && live.reason) || "APPLY_FAILED"}`)}) - it `
          + "applies at the next restart");
      }
    }
    return { ok: true, changed: false, revision, apply, pending, warnings };
  }

  function commit(ctx, op) {
    const { entry, provider, rows, filePath, file } = ctx;
    const revision = file.revision + 1;
    const actor = actorOf(op.actor);
    const atMs = nowMs();
    const written = writeOverrideFileAtomic(filePath, { schemaVersion: OVERRIDE_SCHEMA_VERSION, revision,
      updatedAtMs: atMs, updatedBy: actor.characterId, values: op.values }, deps.fsApi);
    if (!written.ok) return refuse("WRITE_FAILED", written.detail);
    const faults = [];
    const step = (fn, fallback) => {
      try {
        return fn();
      } catch (err) {
        faults.push(clip((err && err.message) || err));
        return fallback;
      }
    };
    let apply = step(() => provider.apply(op.key), APPLY_FALLBACK);
    const masked = op.locked || !ctx.keys.has(op.key);
    let liveFault = null;
    if (apply === APPLY_LIVE) {
      let live;
      try {
        live = masked || typeof deps.applyLive !== "function" ? { ok: false, reason: "NOT_LIVE" }
          : deps.applyLive({ entry, modId: provider.modId, key: op.key, after: op.after });
      } catch (err) {
        live = { ok: false, reason: "APPLY_FAILED", detail: (err && err.message) || err };
      }
      if (live && live.ok === true && Array.isArray(live.applied) && live.applied.includes(op.key)) {
        count("liveApplied");
      } else {
        apply = APPLY_FALLBACK;
        liveFault = clip(`${(live && live.reason) || "APPLY_FAILED"}${live && live.detail ? ` ${live.detail}` : ""}`);
      }
    }
    const shownValue = (v) => (op.locked ? MASK : v === undefined ? null : v);
    let auditFailed = false;
    if (audit) {
      const r = step(() => audit.append({ atMs, characterId: actor.characterId, characterName: actor.characterName,
        channel: actor.channel, mod: provider.modId, key: op.key, action: op.action,
        before: masked ? shownValue(undefined) : shownValue(op.before.values[op.key]),
        after: masked ? shownValue(undefined) : shownValue(op.after.values[op.key]), revision, apply }), null);
      auditFailed = !r || r.ok !== true;
    }
    if (auditFailed) count("auditFailed");
    count(op.action === "set" ? "writes" : "resets");
    step(() => log(`${provider.modId}.${clip(op.key)} ${op.action} by ${actor.characterName || "?"} `
      + `(${actor.characterId || "?"}, ${actor.channel || "?"}) revision ${revision} (${apply})`
      + `${auditFailed ? " - audit failed" : ""}`), null);
    const warnings = step(() => redactRowMessages(freshOf(op.after.warnings, op.before.warnings), rows), []);
    if (env[IGNORE_ENV] === "1") warnings.push(`${IGNORE_ENV}=1: the override files are ignored`);
    const pending = liveFault !== null ? true : apply === APPLY_LIVE ? false
      : step(() => pendingOf(entry, op.key, op.after), true);
    if (liveFault !== null) {
      warnings.push(`saved at revision ${revision}; the live apply failed (${liveFault}) - it applies at the next `
        + "restart");
      step(() => log(`${provider.modId}.${clip(op.key)} live apply failed - ${liveFault}`), null);
    }
    if (faults.length > 0) warnings.push(`saved at revision ${revision}; a step after the write failed - ${faults[0]}`);
    return { ok: true, changed: true, revision, apply, pending, warnings,
      ...(auditFailed ? { auditFailed: true } : {}) };
  }

  function setSetting(req) {
    try {
      const r = isPlainObject(req) ? req : {};
      const p = providerOf(r.modId);
      if (p.refusal) return p.refusal;
      const key = r.key;
      if (typeof key !== "string" || !p.keys.has(key)) return refuse("UNKNOWN_KEY");
      const lock = p.provider.locked(key);
      if (lock && lock.locked === true) return refuse("LOCKED", lock.reason);
      const valid = p.provider.validate(key, r.value);
      if (!valid || valid.ok !== true) return refuse((valid && valid.reason) || "BAD_VALUE");
      if (env[IGNORE_ENV] === "1") return refuse("CONFIG_ERROR", `${IGNORE_ENV}=1: the override files are ignored`);
      const f = fileOf(p.provider);
      if (f.refusal) return f.refusal;
      const stale = staleOf(f.file, r.expectedRevision);
      if (stale) return stale;
      const before = p.provider.resolve(f.file.values);
      if (hasOwn(f.file.values, key) && jsonOf(f.file.values[key]) === jsonOf(valid.value)
        && before.sources[key] === SOURCE_OVERRIDE) {
        return noopOf(p, f.file.revision, key, before);
      }
      const values = { ...f.file.values, [key]: valid.value };
      const after = p.provider.resolve(values);
      const newErrors = redactRowMessages(freshOf(after.errors, before.errors), p.rows);
      if (newErrors.length > 0) return refuse("CONFIG_ERROR", newErrors[0]);
      if (after.sources[key] !== SOURCE_OVERRIDE) {
        const why = redactRowMessages(freshOf(after.warnings, before.warnings), p.rows);
        return refuse("BAD_VALUE", why.find((m) => m.includes(key)) || why[0] || "the mod does not take the value");
      }
      return commit({ ...p, ...f }, { action: "set", key, values, before, after, actor: r.actor, locked: false });
    } catch (err) {
      return refuse("WRITE_FAILED", (err && err.message) || err);
    }
  }

  function resetSetting(req) {
    try {
      const r = isPlainObject(req) ? req : {};
      const p = providerOf(r.modId);
      if (p.refusal) return p.refusal;
      const key = r.key;
      if (typeof key !== "string") return refuse("UNKNOWN_KEY");
      if (env[IGNORE_ENV] === "1") return refuse("CONFIG_ERROR", `${IGNORE_ENV}=1: the override files are ignored`);
      const f = fileOf(p.provider);
      if (f.refusal) return f.refusal;
      const known = p.keys.has(key);
      const lock = known ? p.provider.locked(key) : null;
      const locked = Boolean(lock && lock.locked === true);
      const inFile = hasOwn(f.file.values, key);
      if (!inFile && !known) return refuse("UNKNOWN_KEY");
      if (!inFile && locked) return refuse("LOCKED", lock.reason);
      const stale = staleOf(f.file, r.expectedRevision);
      if (stale) return stale;
      const before = p.provider.resolve(f.file.values);
      if (!inFile) {
        return { ok: true, changed: false, revision: f.file.revision, apply: p.provider.apply(key),
          pending: pendingOf(p.entry, key, before), warnings: [] };
      }
      const values = Object.fromEntries(Object.entries(f.file.values).filter(([k]) => k !== key));
      const after = p.provider.resolve(values);
      if (known && !locked) {
        const newErrors = redactRowMessages(freshOf(after.errors, before.errors), p.rows);
        if (newErrors.length > 0) return refuse("CONFIG_ERROR", newErrors[0]);
      }
      return commit({ ...p, ...f }, { action: "reset", key, values, before, after, actor: r.actor, locked });
    } catch (err) {
      return refuse("WRITE_FAILED", (err && err.message) || err);
    }
  }

  return Object.freeze({ setSetting, resetSetting });
}

module.exports = { COUNTER_NAMES, createWriter };
