"use strict";

const { fingerprint } = require("../util/fingerprint");
const { strengthOf } = require("../strategy/ai/strength");
const S = require("./schema");
const { phaseUnits, unitsAt } = require("./machine");

const HASH_HEX = 40;
const ITEM_ID_STRIDE = 1000;
const MAX_DAMAGE_FACTIONS = 16;
const OWNER_KIND = "faction";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isText = (v, max) => typeof v === "string" && v !== "" && v.length <= max;
const messageOf = (err) => String((err && err.message) || err).slice(0, 160);

function battleKeyOf(spec) {
  return `wbb:${fingerprint({ bossId: spec.bossId, visitNo: spec.visitNo, round: spec.round,
    factionId: spec.factionId }).slice(0, HASH_HEX)}`;
}

function buildEntries(row, catalogKind, units) {
  const phaseDef = catalogKind && catalogKind.phases ? catalogKind.phases[row.phase - 1] : null;
  if (!phaseDef) return [];
  const out = [];
  let index = 0;
  for (const unit of phaseDef.units) {
    for (let n = 1; n <= unit.count; n += 1) {
      const key = `${unit.key}${n}`;
      const hp = units ? units[key] : undefined;
      if (Number.isSafeInteger(hp) && hp >= 1) {
        out.push({ sentryId: S.sentryIdOf(row.bossNo, row.phase, key), itemId: row.bossNo * ITEM_ID_STRIDE + index + 1,
          typeId: unit.typeId, ownerKind: OWNER_KIND, ownerId: row.factionId, hp, ehp: hp, dps: unit.dps,
          signature: unit.signature, designSig: unit.designSig });
      }
      index += 1;
    }
  }
  return out;
}

function hostileOf(isHostile, a, b) {
  try {
    return typeof isHostile === "function" && isHostile(a, b) === true;
  } catch (_err) {
    return false;
  }
}

function decideClash(row, fleetsInSystem, isHostile, cfg) {
  if (!row || row.state !== S.STATES.DWELL) return { action: "NOT_DWELL" };
  if (row.mode === S.MODES.LIVE) return { action: "WAIT_LIVE" };
  if ((Array.isArray(row.openClashes) ? row.openClashes.length : 0) >= cfg.maxOpen) return { action: "MAX_OPEN" };
  const list = Array.isArray(fleetsInSystem) ? fleetsInSystem : [];
  const truncated = list.length > cfg.maxFleetsRead;
  const roles = Array.isArray(cfg.roles) ? cfg.roles : [];
  const table = cfg.powerTable || {};
  const byFaction = new Map();
  for (const f of list.slice(0, cfg.maxFleetsRead)) {
    if (!f || !isText(f.fleetId, 64) || !isId(f.factionId) || f.factionId === row.factionId) continue;
    if (!roles.includes(f.fleetRole) || !Number.isSafeInteger(f.version)) continue;
    if (!hostileOf(isHostile, row.factionId, f.factionId)) continue;
    const side = byFaction.get(f.factionId) || { factionId: f.factionId, strength: 0, fleets: [] };
    side.strength += strengthOf(f.composition, table);
    side.fleets.push(f);
    byFaction.set(f.factionId, side);
  }
  if (byFaction.size === 0) return { action: "NO_ENEMY" };
  const best = [...byFaction.values()].sort((a, b) => b.strength - a.strength || a.factionId - b.factionId)[0];
  const fleets = best.fleets.sort((a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0))
    .slice(0, cfg.maxFleetsPerSide).map((f) => ({ fleetId: f.fleetId, expectedVersion: f.version }));
  return { action: truncated ? "TRUNCATED" : "CLASH", factionId: best.factionId, fleets };
}

function applyDamage(row, entries, catalogKind, now, cfg) {
  const phases = catalogKind && Array.isArray(catalogKind.phases) ? catalogKind.phases : [];
  const phaseDef = phases[row.phase - 1];
  const out = { units: {}, phase: row.phase, phaseCleared: false, defeated: false, applied: 0, stale: 0, damage: 0 };
  if (!phaseDef) {
    out.stale = Array.isArray(entries) ? entries.length : 0;
    return out;
  }
  const units = { ...unitsAt({ units_json: row.unitsJson, hp_at: row.hpAt }, now, phaseDef, cfg).units };
  for (const e of Array.isArray(entries) ? entries : []) {
    const id = S.parseSentryId(e && e.sentryId);
    if (!id || id.bossNo !== row.bossNo || id.phase !== row.phase
      || !Object.prototype.hasOwnProperty.call(units, id.unitKey)) {
      out.stale += 1;
      continue;
    }
    const dmg = Number.isFinite(e.damage) && e.damage > 0 ? Math.floor(e.damage) : 0;
    const before = Number(units[id.unitKey]) || 0;
    units[id.unitKey] = e.destroyed === true ? 0 : Math.max(0, before - dmg);
    out.applied += 1;
    out.damage += dmg;
  }
  out.units = units;
  const alive = Object.values(units).some((hp) => hp > 0);
  if (out.applied > 0 && !alive) {
    out.phaseCleared = true;
    if (row.phase < phases.length) {
      out.phase = row.phase + 1;
      out.units = phaseUnits(phases[row.phase]);
    } else out.defeated = true;
  }
  return out;
}

function addDamage(damageBy, factionId, damage) {
  const out = { ...(damageBy || {}) };
  const key = String(factionId);
  if (Object.prototype.hasOwnProperty.call(out, key) || Object.keys(out).length < MAX_DAMAGE_FACTIONS) {
    out[key] = (out[key] || 0) + damage;
    return out;
  }
  const smallest = Object.entries(out).sort((a, b) => a[1] - b[1] || Number(a[0]) - Number(b[0]))[0][0];
  out[smallest] += damage;
  return out;
}

function topFactionOf(damageBy) {
  const list = Object.entries(damageBy || {}).filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
  return list.length > 0 ? Number(list[0][0]) : null;
}

function createConsequence(deps) {
  const { repo, journal, kinds, settings: P } = deps;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};

  function applyInner(tx, settled, ck) {
    const all = settled && Array.isArray(settled.fixedDefenses) ? settled.fixedDefenses : [];
    const mine = all.filter((e) => e && typeof e.sentryId === "string" && e.sentryId.startsWith(S.SENTRY_PREFIX));
    if (mine.length === 0) return { ok: true, skipped: true };
    if (typeof deps.isActive === "function" && deps.isActive() !== true) {
      return { ok: false, reason: "WORLD_BOSSES_STOPPED" };
    }
    if (!isText(ck, 200) || !isText(settled.battleId, 64) || !Number.isSafeInteger(settled.at) || settled.at < 0) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const key = S.keyDamage(ck);
    const seen = journal.findByKey(tx, key);
    if (!seen.ok) return { ok: false, reason: seen.reason || "JOURNAL_READ_FAILED" };
    if (seen.found) return { ok: true, duplicate: true, applied: 0, stale: 0, defeated: false };
    const first = S.parseSentryId(mine[0].sentryId);
    if (!first) {
      bump("staleDamage", mine.length);
      return { ok: true, applied: 0, stale: mine.length, defeated: false };
    }
    const got = repo.getByNoInTx(tx, first.bossNo);
    if (!got.ok) return got;
    if (!got.row) return { ok: false, reason: "BOSS_NOT_FOUND" };
    const row = got.row;
    if (!S.OPEN_STATES.includes(row.state)) {
      bump("staleDamage", mine.length);
      return { ok: true, applied: 0, stale: mine.length, defeated: false };
    }
    const entry = kinds.get(row.kind);
    if (!entry) return { ok: false, reason: "KIND_UNKNOWN" };
    const at = settled.at;
    const d = applyDamage(row, mine, entry, at, P);
    const sideA = settled.sides && settled.sides.A ? settled.sides.A : null;
    const factionId = sideA && isId(sideA.factionId) ? sideA.factionId : null;
    const damageBy = factionId !== null && d.damage > 0 ? addDamage(row.damageBy, factionId, d.damage)
      : { ...row.damageBy };
    const patch = { unitsJson: JSON.stringify(d.units), hpAt: Math.max(row.hpAt, at), phase: d.phase,
      openClashesJson: JSON.stringify(row.openClashes.filter((id) => id !== settled.battleId)),
      damageByJson: JSON.stringify(damageBy) };
    let to = row.state;
    let top = null;
    if (d.defeated) {
      top = topFactionOf(damageBy);
      if (typeof deps.cleanupInTx === "function") deps.cleanupInTx(tx, row.siteEventId, "EVENT_END");
      Object.assign(patch, { endedAt: at, endReason: S.END_REASONS.DEFEATED, siteEventId: null,
        rewardState: S.REWARD_STATES.PENDING, topFactionId: top, stepSeq: row.stepSeq + 1 });
      to = S.STATES.DEFEATED;
    }
    const r = repo.transitionInTx(tx, { bossId: row.bossId, expectedVersion: row.version, from: row.state, to, now: at,
      patch }, { key, eventType: S.EVENT.DAMAGED, payload: { bossId: row.bossId, battleId: settled.battleId,
      applied: d.applied, stale: d.stale, damage: d.damage, phase: d.phase, defeated: d.defeated } });
    if (!r.ok) {
      if (r.reason === "VERSION_CONFLICT") {
        bump("clashRefused");
        return { ok: false, reason: "CAS_LOST" };
      }
      return { ok: false, reason: r.reason || "TRANSITION_FAILED", ...(r.detail ? { detail: r.detail } : {}) };
    }
    if (d.defeated) {
      const end = journal.applyOnce(tx, { key: S.keyEnd(row.bossId), aggregate: { type: S.JOURNAL_AGGREGATE,
        id: row.bossId }, eventType: S.EVENT.ENDED, payload: { bossId: row.bossId, kind: row.kind,
        factionId: row.factionId, systemId: row.systemId, regionId: row.regionId, outcome: S.STATES.DEFEATED,
        reason: S.END_REASONS.DEFEATED, topFactionId: top } }, () => true);
      if (!end.ok) return { ok: false, reason: end.reason || "END_MARK_FAILED" };
    }
    bump("damageApplied", d.applied);
    bump("staleDamage", d.stale);
    if (d.phaseCleared) bump("phaseCleared");
    if (d.defeated) {
      bump("defeated");
      if (typeof deps.onDefeated === "function") deps.onDefeated(row.bossId);
    }
    return { ok: true, applied: d.applied, stale: d.stale, defeated: d.defeated };
  }

  return Object.freeze({ name: "worldBosses", apply(tx, settled, ck) {
    try {
      return applyInner(tx, settled, ck);
    } catch (err) {
      return { ok: false, reason: "WORLD_BOSS_CONSEQUENCE_FAILED", detail: messageOf(err) };
    }
  } });
}

module.exports = { battleKeyOf, buildEntries, decideClash, applyDamage, addDamage, topFactionOf, createConsequence,
  MAX_DAMAGE_FACTIONS };
