"use strict";

const FAMILY_LAYER = Object.freeze({
  remoteArmor: "armor", remoteShield: "shield", remoteHull: "structure", remoteCapacitor: "capacitor",
});
const KIND = Object.freeze(["host", "twin"]);
const CYCLE_REASON = Object.freeze(["TARGET_REQUIRED", "TARGET_NOT_FOUND", "TARGET_NOT_LOCKED", "UNSUPPORTED_MODULE",
  "TARGET_OUT_OF_RANGE", "OTHER"]);
const FULL_PCT = 100;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : 0;
}

function layerPct(entity, layer) {
  const cs = entity && entity.conditionState && typeof entity.conditionState === "object" ? entity.conditionState : {};
  if (layer === "shield") return num(cs.shieldCharge, 1) * FULL_PCT;
  if (layer === "armor") return (1 - num(cs.armorDamage, 0)) * FULL_PCT;
  if (layer === "structure") return (1 - num(cs.damage, 0)) * FULL_PCT;
  if (layer === "capacitor") return Math.min(1, Math.max(0, num(entity && entity.capacitorChargeRatio, 1))) * FULL_PCT;
  return FULL_PCT;
}

function isShip(entity) {
  return Boolean(entity) && typeof entity === "object" && entity.kind === "ship" && entity.destroyed !== true
    && toInt(entity.itemID) > 0;
}

function candidates(input) {
  const src = input || {};
  const twin = src.twin || null;
  const twinId = toInt(twin && twin.itemID);
  const owner = toInt(src.ownerCharId);
  const inScene = typeof src.sameScene === "function" ? src.sameScene : () => false;
  const ok = (entity) => {
    if (!isShip(entity) || entity === twin || toInt(entity.itemID) === twinId) return false;
    try {
      return inScene(entity) === true;
    } catch (_err) {
      return false;
    }
  };
  const out = [];
  const seen = new Set();
  if (ok(src.host)) {
    out.push({ entity: src.host, kind: "host" });
    seen.add(toInt(src.host.itemID));
  }
  for (const entity of Array.isArray(src.wingTwins) ? src.wingTwins : []) {
    if (!ok(entity) || seen.has(toInt(entity.itemID))) continue;
    if (owner > 0 && toInt(entity.pilotCharacterID) !== owner) continue;
    out.push({ entity, kind: "twin" });
    seen.add(toInt(entity.itemID));
  }
  return out;
}

function pick(list, family, thresholdPct) {
  const layer = FAMILY_LAYER[family];
  if (!layer) return null;
  const limit = num(thresholdPct, 0);
  let best = null;
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.entity || !KIND.includes(c.kind)) continue;
    if (layer === "capacitor" && c.kind !== "host") continue;
    const pct = layerPct(c.entity, layer);
    if (!(pct < limit)) continue;
    const better = best === null || pct < best.pct
      || (pct === best.pct && (c.kind === "host") !== (best.kind === "host") && c.kind === "host")
      || (pct === best.pct && c.kind === best.kind && toInt(c.entity.itemID) < toInt(best.entity.itemID));
    if (better) best = { entity: c.entity, kind: c.kind, pct };
  }
  return best;
}

function allowedIds(list) {
  return new Set((Array.isArray(list) ? list : []).map((c) => toInt(c && c.entity && c.entity.itemID))
    .filter((id) => id > 0));
}

module.exports = { FAMILY_LAYER, KIND, CYCLE_REASON, layerPct, candidates, pick, allowedIds };
