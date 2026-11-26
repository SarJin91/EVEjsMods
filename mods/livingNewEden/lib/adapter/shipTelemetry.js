"use strict";

const PERMILLE = 1000;
const REASONS = Object.freeze({ NO_SESSION: "NO_SESSION", NO_SHIP: "NO_SHIP", SEAM: "SEAM_UNAVAILABLE" });
const MAX_NAME_CHARS = 100;

const isObj = (v) => Boolean(v) && typeof v === "object";
const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const permille = (ratio) => Math.round(clamp01(ratio) * PERMILLE);
const fn = (mod, name) => (isObj(mod) && typeof mod[name] === "function" ? mod[name] : null);

function sessionOf(registry, playerId) {
  const getSessions = fn(registry, "getSessions");
  if (!getSessions) return { ok: false, reason: REASONS.SEAM };
  const sessions = getSessions.call(registry);
  if (!sessions || typeof sessions[Symbol.iterator] !== "function") return { ok: false, reason: REASONS.SEAM };
  for (const s of sessions) {
    if (isObj(s) && Math.trunc(num(s.characterID || s.charid)) === playerId) return { ok: true, session: s };
  }
  return { ok: false, reason: REASONS.NO_SESSION };
}

function ratiosOf(max, cur) {
  return {
    shield: max.shield > 0 ? clamp01(num(cur.shield) / max.shield) : 0,
    armor: max.armor > 0 ? clamp01(num(cur.armor) / max.armor) : 0,
    structure: max.structure > 0 ? clamp01(num(cur.structure) / max.structure) : 0,
  };
}

function speedOf(entity) {
  const v = entity.velocity;
  if (!isObj(v) || ![v.x, v.y, v.z].every((c) => typeof c === "number" && Number.isFinite(c))) return null;
  return Math.round(Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z));
}

function fromItem(itemStore, shipId, docked) {
  const find = fn(itemStore, "findItemById");
  if (!find) return { ok: false, reason: REASONS.SEAM };
  const item = shipId > 0 ? find.call(itemStore, shipId) : null;
  if (!isObj(item)) return { ok: false, reason: REASONS.NO_SHIP };
  const c = isObj(item.conditionState) ? item.conditionState : {};
  const have = (v) => v !== undefined && v !== null && Number.isFinite(Number(v));
  return { ok: true, docked, shipTypeId: Number.isSafeInteger(item.typeID) ? item.typeID : null,
    shieldPermille: permille(have(c.shieldCharge) ? Number(c.shieldCharge) : 1),
    armorPermille: permille(1 - (have(c.armorDamage) ? Number(c.armorDamage) : 0)),
    structurePermille: permille(1 - (have(c.damage) ? Number(c.damage) : 0)),
    capacitorPermille: have(c.charge) ? permille(Number(c.charge)) : null,
    speedMps: docked ? 0 : null, warping: docked ? false : null, entityId: null, position: null };
}

function pointOf(value) {
  if (!isObj(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function readShipTelemetryFrom(mods, playerId) {
  try {
    const m = mods || {};
    if (!Number.isSafeInteger(playerId) || playerId <= 0) return { ok: false, reason: REASONS.NO_SESSION };
    const found = sessionOf(m.sessionRegistry, playerId);
    if (!found.ok) return found;
    const s = found.session;
    const docked = Boolean(s.stationid || s.stationID || s.structureid || s.structureID);
    const space = !docked && isObj(s._space) ? s._space : null;
    const shipId = Math.trunc(num((space && space.shipID) || s.shipID || s.shipid));
    if (!space) return fromItem(m.itemStore, shipId, docked);
    const getEntity = fn(m.runtime, "getEntity");
    const maxOf = fn(m.damage, "getEntityMaxHealthLayers");
    const curOf = fn(m.damage, "getEntityCurrentHealthLayers");
    const capOf = fn(m.capacitor, "getEntityCapacitorRatio");
    if (!getEntity || !maxOf || !curOf || !capOf) return { ok: false, reason: REASONS.SEAM };
    const entity = shipId > 0 ? getEntity.call(m.runtime, s, shipId) : null;
    if (!isObj(entity)) return { ok: false, reason: REASONS.NO_SHIP };
    const max = maxOf.call(m.damage, entity);
    const cur = curOf.call(m.damage, entity, max);
    if (!isObj(max) || !isObj(cur)) return { ok: false, reason: REASONS.SEAM };
    const r = ratiosOf(max, cur);
    const cap = Number(capOf.call(m.capacitor, entity));
    return { ok: true, docked: false, shipTypeId: Number.isSafeInteger(entity.typeID) ? entity.typeID : null,
      shieldPermille: permille(r.shield), armorPermille: permille(r.armor), structurePermille: permille(r.structure),
      capacitorPermille: Number.isFinite(cap) ? permille(cap) : null, speedMps: speedOf(entity),
      warping: typeof entity.mode === "string" ? entity.mode.toUpperCase() === "WARP" : null,
      entityId: shipId > 0 ? shipId : null, position: pointOf(entity.position) };
  } catch (_err) {
    return { ok: false, reason: REASONS.SEAM };
  }
}

function findItemTypeByNameFrom(registry, name) {
  try {
    const resolve = fn(registry, "resolveItemByName");
    if (!resolve) return { ok: false, reason: REASONS.SEAM };
    const r = resolve.call(registry, String(name ?? ""), { exactOnly: true });
    const e = r && r.success === true && isObj(r.match) ? r.match : null;
    if (!e || !Number.isSafeInteger(Number(e.typeID)) || Number(e.typeID) <= 0) return { ok: true, found: false };
    const cat = Number(e.categoryID);
    const vol = Number(e.volume);
    return { ok: true, found: true, item: { typeId: Number(e.typeID), name: String(e.name || "").slice(0, MAX_NAME_CHARS),
      groupName: typeof e.groupName === "string" && e.groupName !== "" ? e.groupName.slice(0, MAX_NAME_CHARS) : null,
      categoryId: Number.isSafeInteger(cat) && cat > 0 ? cat : null,
      volume: e.volume !== null && Number.isFinite(vol) && vol >= 0 ? vol : null } };
  } catch (_err) {
    return { ok: false, reason: REASONS.SEAM };
  }
}

function readSkillSummaryFrom(skillState, playerId, maxGroups) {
  try {
    const cachedFn = fn(skillState, "isCharacterSkillMapCached");
    const mapFn = fn(skillState, "getCachedCharacterSkillMap");
    if (!cachedFn || !mapFn) return { ok: false, reason: REASONS.SEAM };
    if (cachedFn.call(skillState, playerId) !== true) return { ok: false, reason: "NOT_CACHED" };
    const map = mapFn.call(skillState, playerId);
    if (!(map instanceof Map)) return { ok: false, reason: REASONS.SEAM };
    let totalSp = 0;
    const byGroup = new Map();
    for (const rec of map.values()) {
      const sp = Math.max(0, Math.trunc(num(rec && rec.skillPoints)));
      totalSp += sp;
      const group = isObj(rec) && typeof rec.groupName === "string" && rec.groupName !== "" ? rec.groupName : "?";
      byGroup.set(group, (byGroup.get(group) || 0) + sp);
    }
    const groups = [...byGroup].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, Math.max(1, maxGroups)).map(([name, sp]) => ({ name: name.slice(0, MAX_NAME_CHARS), sp }));
    return { ok: true, totalSp, groups };
  } catch (_err) {
    return { ok: false, reason: REASONS.SEAM };
  }
}

const positiveInt = (v) => {
  const n = Math.trunc(num(v));
  return n > 0 ? n : 0;
};

function inWarpOf(entity) {
  return isObj(entity) && (String(entity.mode || "").trim().toUpperCase() === "WARP" || Boolean(entity.pendingWarp)
    || Boolean(entity.warpState));
}

function readGridNpcsFrom(mods, systemId, opts) {
  try {
    const m = mods || {};
    const maxScan = opts && Number.isSafeInteger(opts.maxScan) && opts.maxScan > 0 ? opts.maxScan : 0;
    if (!Number.isSafeInteger(systemId) || systemId <= 0 || maxScan === 0) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const runtime = m.runtime;
    const list = fn(m.registry, "listControllersBySystem");
    if (!fn(runtime, "isSolarSystemSceneLoaded") || !(runtime.scenes instanceof Map) || !list) {
      return { ok: false, reason: REASONS.SEAM };
    }
    if (runtime.isSolarSystemSceneLoaded(systemId) !== true) return { ok: false, reason: "SCENE_NOT_LOADED" };
    const scene = runtime.scenes.get(systemId);
    if (!isObj(scene) || typeof scene.getEntityByID !== "function") return { ok: false, reason: "SCENE_NOT_LOADED" };
    const controllers = list.call(m.registry, systemId);
    if (!Array.isArray(controllers)) return { ok: false, reason: REASONS.SEAM };
    const resolve = fn(m.factionKill, "resolveVictimFactionID");
    const ownerFaction = fn(m.standing, "getOwnerFactionID");
    const siteRef = fn(m.dungeon, "getInstanceRef");
    const tryId = (f) => {
      try {
        return positiveInt(f());
      } catch (_err) {
        return 0;
      }
    };
    const factionOf = (entity, passive) => {
      const direct = resolve ? tryId(() => resolve.call(m.factionKill, entity)) : 0;
      if (direct > 0) return direct;
      if (passive) return null;
      const owner = positiveInt(entity.ownerID);
      const byOwner = ownerFaction && owner > 0 ? tryId(() => ownerFaction.call(m.standing, owner)) : 0;
      if (byOwner > 0) return byOwner;
      const instanceId = positiveInt(entity.dungeonSiteInstanceID);
      const bySite = siteRef && instanceId > 0 ? tryId(() => {
        const inst = siteRef.call(m.dungeon, instanceId);
        return isObj(inst) ? inst.factionID : 0;
      }) : 0;
      return bySite > 0 ? bySite : null;
    };
    const passiveOf = (c, targetId) => {
      const o = isObj(c.behaviorOverrides) ? c.behaviorOverrides : null;
      return Boolean(o) && o.autoAggro === false && !(num(o.proximityAggroRangeMeters) > 0) && targetId === 0;
    };
    const askedLookups = opts && Number.isSafeInteger(opts.maxLookups) && opts.maxLookups > 0 ? opts.maxLookups
      : maxScan * 2;
    const maxLookups = Math.max(askedLookups, maxScan);
    const npcs = [];
    let withEntity = 0;
    let truncated = false;
    for (let i = controllers.length - 1, lookups = 0; i >= 0; i -= 1, lookups += 1) {
      if (withEntity >= maxScan || lookups >= maxLookups) {
        truncated = true;
        break;
      }
      const c = controllers[i];
      const entityId = isObj(c) ? positiveInt(c.entityID) : 0;
      const entity = entityId > 0 ? scene.getEntityByID(entityId) : null;
      if (!isObj(entity)) continue;
      withEntity += 1;
      const position = pointOf(entity.position);
      if (!position) continue;
      const order = isObj(c.manualOrder) ? c.manualOrder : null;
      const ordered = order && String(order.type || "").toLowerCase() === "attack" ? positiveInt(order.targetID) : 0;
      const current = positiveInt(c.currentTargetID);
      const targetId = current > 0 ? current : ordered;
      npcs.push({ entityId, typeId: Number.isSafeInteger(entity.typeID) && entity.typeID > 0 ? entity.typeID : null,
        factionId: factionOf(entity, passiveOf(c, targetId)), position, targetId, inWarp: inWarpOf(entity) });
    }
    npcs.reverse();
    return { ok: true, truncated, npcs };
  } catch (_err) {
    return { ok: false, reason: REASONS.SEAM };
  }
}

module.exports = { readShipTelemetryFrom, findItemTypeByNameFrom, readSkillSummaryFrom, sessionOf, readGridNpcsFrom,
  inWarpOf };
