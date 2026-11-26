"use strict";

const { performance } = require("node:perf_hooks");
const { createPoller } = require("../../presence/poller");
const { relationOf, huntThresholds } = require("../../playerHunt/policy");
const { parseNeutralPolicy } = require("../../playerHunt/schema");
const S = require("./schema");
const { planCharacter } = require("./plan");
const { createLocalContactsRepository } = require("./repository");

const MS_DECIMALS = 10;
const MAX_DETAIL = 160;
const PRESENCE_MAX_CHARACTERS = 4096;

class Abort extends Error {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function persistenceStore(ctx) {
  const p = ctx && ctx.persistence;
  return p && p.ok === true && p.store && typeof p.store.transaction === "function" ? p.store : null;
}

function createUnavailableLocalContacts(reason) {
  const why = String(reason || "LOCAL_CONTACTS_UNAVAILABLE");
  const mode = why === "SEAM_UNAVAILABLE" ? S.MODE.SEAM_UNAVAILABLE : S.MODE.STOPPED;
  return Object.freeze({
    runPassNow: () => ({ ok: false, reason: why }),
    getStatus: () => Object.freeze({ mode, reason: why }),
    stop: () => {},
  });
}

function startLocalContacts(deps) {
  const config = deps && deps.config;
  const LC = config && config.localContacts;
  if (!LC) return { ok: false, reason: "disabled_by_config" };
  const ctx = deps.ctx || {};
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const getFactionKind = typeof deps.getFactionKind === "function" ? deps.getFactionKind : () => null;
  const full = LC.enabled === true && Boolean(config.localPilots && config.localPilots.enabled === true)
    && Boolean(config.modules && config.modules.virtualCorps && config.modules.virtualCorps.enabled === true);

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`localContacts: ${line}`);
    } catch (_err) {
    }
  }

  const store = persistenceStore(ctx);
  if (!store) return { ok: false, reason: full ? "NO_PERSISTENCE_STORE" : "disabled_by_config" };
  const repo = createLocalContactsRepository();

  function counts() {
    const res = store.transaction("localContacts.count", (db) => repo.countRows(db));
    return res && res.ok === true && res.value && res.value.ok === true ? res.value : null;
  }

  let mode = full ? S.MODE.FULL : S.MODE.CLEANUP;
  if (!full) {
    const c = counts();
    if (c === null) return { ok: false, reason: "disabled_by_config", detail: "registry count refused" };
    if (c.live === 0) return { ok: false, reason: "disabled_by_config" };
  }

  const adapter = ctx.adapter;
  let seams = null;
  try {
    seams = adapter && typeof adapter.personalContactsSeams === "function" ? adapter.personalContactsSeams() : null;
  } catch (err) {
    seams = { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(err) };
  }
  if (!seams || seams.ok !== true || !seams.seam) {
    const detail = seams ? `${seams.reason || "unknown"}${seams.detail ? `:${seams.detail}` : ""}` : "no_seam";
    log(`not started (${mode}) - SEAM_UNAVAILABLE (${detail})`);
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail };
  }
  const seam = seams.seam;

  const counters = Object.fromEntries(S.COUNTER_NAMES.map((name) => [name, 0]));
  const thresholds = huntThresholds(config.playerHunt || {});
  const neutralPolicy = parseNeutralPolicy((config.playerHunt || {}).neutralPolicy) || {};
  let cursor = 0;
  let lastPassAt = null;
  let lastCounts = { live: 0, released: 0 };
  let vcReady = false;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    metric("count", `localContacts.${name}`, n);
  }

  function governorAdmits() {
    try {
      const governor = ctx.governor;
      return !governor || typeof governor.admits !== "function" || governor.admits(S.WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function factionContacts() {
    const vc = ctx.virtualCorps;
    if (!vc || typeof vc.listIdentities !== "function" || typeof vc.getFactionIdentity !== "function") return null;
    let rows;
    try {
      rows = vc.listIdentities();
    } catch (_err) {
      return null;
    }
    if (!Array.isArray(rows)) return null;
    const factions = [...new Set(rows.filter((r) => r && r.owner_kind === "faction" && isId(Number(r.owner_id)))
      .map((r) => Number(r.owner_id)))].sort((a, b) => a - b);
    const byFaction = new Map();
    const contactFaction = new Map();
    for (const factionId of factions) {
      let id;
      try {
        id = vc.getFactionIdentity(factionId);
      } catch (_err) {
        id = null;
      }
      if (!id || id.ok !== true) continue;
      const corps = Array.isArray(id.corporationIds) ? id.corporationIds.filter(isId) : [];
      const useAlliance = LC.contactLevel !== "corporation" && isId(id.allianceId);
      const level = useAlliance ? "alliance" : "corporation";
      const ids = useAlliance ? [id.allianceId] : corps;
      if (ids.length === 0) continue;
      byFaction.set(factionId, ids);
      for (const c of ids) contactFaction.set(c, { factionId, level });
    }
    return { byFaction, contactFaction };
  }

  function onlineCharacters() {
    if (mode !== S.MODE.FULL || !adapter || typeof adapter.readPresence !== "function") return [];
    let r;
    try {
      r = adapter.readPresence({ maxCharacters: PRESENCE_MAX_CHARACTERS });
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true || !Array.isArray(r.characters)) return [];
    return r.characters.map((c) => c && c.characterId).filter(isId);
  }

  function charactersOfPass() {
    const max = LC.maxCharactersPerPass;
    const res = store.transaction("localContacts.characters", (db) => {
      const after = repo.listLiveCharacters(db, cursor, max);
      if (!after.ok) throw new Error(`listLiveCharacters: ${after.reason}`);
      let ids = after.ids;
      if (ids.length < max && cursor > 0) {
        const head = repo.listLiveCharacters(db, 0, max);
        if (!head.ok) throw new Error(`listLiveCharacters: ${head.reason}`);
        ids = [...ids, ...head.ids];
      }
      return ids;
    });
    if (!res || res.ok !== true) return null;
    const all = [...new Set([...onlineCharacters(), ...res.value])].sort((a, b) => a - b);
    return [...all.filter((id) => id > cursor), ...all.filter((id) => id <= cursor)];
  }

  function desiredOf(characterId, layout) {
    const desired = new Map();
    const unknown = new Set();
    const known = new Set();
    if (layout === null) return { desired, unknown, known };
    for (const [factionId, ids] of layout.byFaction) {
      for (const c of ids) known.add(c);
      let r;
      try {
        r = typeof adapter.readCharacterStanding === "function" ? adapter.readCharacterStanding(characterId, factionId)
          : null;
      } catch (_err) {
        r = null;
      }
      const standing = r && r.ok === true && typeof r.standing === "number" && Number.isFinite(r.standing)
        ? r.standing : null;
      let kind = null;
      try {
        kind = getFactionKind(factionId);
      } catch (_err) {
        kind = null;
      }
      const relation = relationOf(standing, kind, thresholds, neutralPolicy);
      if (relation === null) {
        bump("unknownStanding");
        for (const c of ids) unknown.add(c);
        continue;
      }
      const rel = S.RELATIONSHIP_OF[relation];
      if (rel === undefined) continue;
      for (const c of ids) desired.set(c, { factionId, level: layout.contactFaction.get(c).level, rel });
    }
    return { desired, unknown, known };
  }

  function writeTransitions(characterId, plan, byContact, now) {
    if (plan.transitions.length === 0) return true;
    const res = store.transaction("localContacts.intent", (db) => {
      for (const t of plan.transitions) {
        const key = { characterId, contactId: t.contactId };
        const reg = byContact.get(t.contactId) || null;
        let r;
        if (reg === null) {
          r = repo.insertAdding(db, { characterId, contactId: t.contactId, factionId: t.factionId, level: t.level,
            writtenRel: t.rel, changedAt: now });
        } else if (t.to === S.DELETE_ROW) {
          r = repo.deleteRow(db, key, reg.version);
        } else if (t.to === S.RELEASED) {
          r = repo.updateRow(db, key, reg.version, { state: S.RELEASED, writtenRel: reg.writtenRel,
            prevRel: reg.prevRel, changedAt: now, releaseReason: t.reason });
        } else {
          r = repo.updateRow(db, key, reg.version, { state: t.to, writtenRel: t.rel, prevRel: t.prev,
            changedAt: t.to === S.OWNED ? reg.changedAt : now, releaseReason: null });
        }
        if (!r || r.ok !== true) throw new Abort(`${t.contactId} ${t.from}->${t.to}: ${(r && r.reason) || "no_result"}`);
      }
      return true;
    });
    if (res && res.ok === true) return true;
    log(`registry write refused for ${characterId} - ${(res && res.reason) || "no_result"}`
      + `${res && res.error ? ` ${messageOf(res.error)}` : ""}`);
    return false;
  }

  function releaseConflicts(characterId, conflicts, now) {
    const res = store.transaction("localContacts.release", (db) => {
      const listed = repo.listForCharacter(db, characterId);
      if (!listed.ok) throw new Abort(`listForCharacter: ${listed.reason}`);
      for (const row of listed.rows) {
        if (!conflicts.includes(row.contactId) || row.state === S.RELEASED) continue;
        const r = repo.updateRow(db, { characterId, contactId: row.contactId }, row.version, { state: S.RELEASED,
          writtenRel: row.writtenRel, prevRel: row.prevRel, changedAt: now,
          releaseReason: S.RELEASE_REASONS.MANUAL_EDIT });
        if (!r.ok) throw new Abort(`release ${row.contactId}: ${r.reason}`);
      }
      return true;
    });
    if (res && res.ok === true) bump("released", conflicts.length);
    else bump("failed");
  }

  function processCharacter(characterId, layout, now) {
    const listed = store.transaction("localContacts.read", (db) => repo.listForCharacter(db, characterId));
    if (!listed || listed.ok !== true || !listed.value || listed.value.ok !== true) {
      bump("failed");
      return "failed";
    }
    const registry = listed.value.rows;
    const byContact = new Map(registry.map((r) => [r.contactId, r]));
    const { desired, unknown, known } = mode === S.MODE.FULL ? desiredOf(characterId, layout)
      : { desired: new Map(), unknown: new Set(), known: new Set() };
    const ids = [...new Set([...known, ...byContact.keys()])].sort((a, b) => a - b);
    const read = seam.read(characterId, ids);
    if (!read || read.ok !== true) {
      bump("failed");
      if (read && read.reason === "CHARACTER_NOT_FOUND") {
        const gone = store.transaction("localContacts.gone", (db) => {
          const r = repo.deleteLiveOfCharacter(db, characterId);
          if (!r.ok) throw new Abort(`deleteLiveOfCharacter: ${r.reason}`);
          return r.removed;
        });
        log(`character ${characterId} has no record - ${gone && gone.ok === true ? `${gone.value} live rows dropped`
          : "drop refused"}`);
      }
      return "failed";
    }
    const plan = planCharacter({ desired, known, unknown, registry, vendor: read.rows, nowMs: now,
      confirmDelayMs: LC.confirmDelayMs });
    bump("skippedManual", plan.skippedManual);
    if (!writeTransitions(characterId, plan, byContact, now)) {
      bump("failed");
      return "failed";
    }
    for (const t of plan.transitions) {
      if (t.to === S.OWNED) bump("confirmed");
      else if (t.to === S.RELEASED) bump("released");
    }
    if (plan.ops.length === 0) return plan.transitions.length > 0 ? "changed" : "idle";
    const applied = seam.apply(characterId, plan.ops);
    if (!applied || applied.ok !== true) {
      bump("failed");
      log(`vendor write refused for ${characterId} - ${(applied && applied.reason) || "no_result"}`
        + `${applied && applied.detail ? ` ${applied.detail}` : ""}`);
      return "failed";
    }
    if (applied.conflicts.length > 0) {
      bump("conflicts", applied.conflicts.length);
      releaseConflicts(characterId, applied.conflicts, now);
    }
    if (applied.written) {
      const done = new Set(applied.applied);
      for (const op of plan.ops) {
        if (!done.has(op.contactId)) continue;
        bump(op.op === "set" ? "set" : "removed");
      }
    }
    return applied.written ? "written" : "changed";
  }

  function refreshCounts() {
    const c = counts();
    if (c !== null) lastCounts = { live: c.live, released: c.released };
    return c;
  }

  function pass() {
    if (mode !== S.MODE.FULL && mode !== S.MODE.CLEANUP) return { ok: false, reason: "not_running" };
    if (!governorAdmits()) {
      bump("deferred");
      return { ok: false, reason: "DEFERRED" };
    }
    if (mode === S.MODE.FULL && !vcReady) return { ok: false, reason: "NOT_READY" };
    const t0 = performance.now();
    try {
      const layout = mode === S.MODE.FULL ? factionContacts() : null;
      if (mode === S.MODE.FULL && layout === null) return { ok: false, reason: "IDENTITIES_UNAVAILABLE" };
      const ordered = charactersOfPass();
      if (ordered === null) {
        bump("failed");
        return { ok: false, reason: "READ_REFUSED" };
      }
      const now = clock.now();
      let writes = 0;
      let done = 0;
      let work = 0;
      for (const characterId of ordered) {
        if (done >= LC.maxCharactersPerPass || writes >= LC.maxWritesPerPass) break;
        const r = processCharacter(characterId, layout, now);
        done += 1;
        cursor = characterId;
        if (r === "written") writes += 1;
        if (r !== "idle") work += 1;
      }
      bump("deferred", ordered.length - done);
      lastPassAt = now;
      const c = refreshCounts();
      if (work > 0) {
        const ms = Math.round((performance.now() - t0) * MS_DECIMALS) / MS_DECIMALS;
        metric("observe", "localContacts.passMs", ms);
      }
      if (mode === S.MODE.CLEANUP && c !== null && c.live === 0) {
        log("cleanup done - no live LNE contact left, service stops");
        stop();
      }
      return { ok: true };
    } catch (err) {
      bump("failed");
      log(`pass failed - ${messageOf(err)}`);
      return { ok: false, reason: "PASS_FAILED", detail: messageOf(err) };
    }
  }

  const poller = createPoller({ runPass: () => { pass(); }, intervalMs: LC.refreshMs, now: () => clock.now(),
    setTimer: deps.setTimer, onError: (err) => { bump("failed"); log(`timer failed - ${messageOf(err)}`); } });

  function stop() {
    if (mode === S.MODE.STOPPED) return;
    mode = S.MODE.STOPPED;
    poller.stop();
  }

  refreshCounts();
  poller.start();
  if (mode === S.MODE.FULL) {
    const vc = ctx.virtualCorps;
    try {
      Promise.resolve(vc && typeof vc.whenReady === "function" ? vc.whenReady() : null)
        .then(() => { vcReady = true; if (mode === S.MODE.FULL) poller.arm(0); }, () => {});
    } catch (_err) {
    }
  } else {
    log(`cleanup mode - ${lastCounts.live} live rows to remove`);
  }

  function getStatus() {
    return { mode, liveRows: lastCounts.live, releasedRows: lastCounts.released, lastPassAt, counters: { ...counters } };
  }

  return { ok: true, localContacts: Object.freeze({ runPassNow: () => pass(), getStatus, stop }) };
}

module.exports = { startLocalContacts, createUnavailableLocalContacts };
