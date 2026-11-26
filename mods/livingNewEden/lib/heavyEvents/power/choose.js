"use strict";

const { STATION_STATES } = require("../../stations/schema");
const H = require("../schema");
const { stockCovers } = require("../candidates");
const P = require("./schema");
const { tierDefOf, maxComposition, pocketCountOf } = require("./catalog");
const { LAYER } = require("../layer");

const STATION_ONLINE = STATION_STATES[0];
const PERMILLE = 1000;
const TYPE_WEIGHT_MAX = 100;

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

const fromMapOrObject = (src, key) => {
  if (src instanceof Map) return src.get(key);
  return src && typeof src === "object" && Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
};

function drawIndex(weights, rng) {
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = rng.nextInt(0, sum - 1);
  for (let i = 0; i < weights.length; i += 1) {
    if (r < weights[i]) return i;
    r -= weights[i];
  }
  return weights.length - 1;
}

const hullTotal = (stock) => Object.values(stock || {}).reduce((a, n) => a + (isCount(n) ? n : 0), 0);

function fundingStationOf(pool, composition) {
  let best = null;
  for (const st of pool) {
    if (!stockCovers(st.hullStock, composition)) continue;
    if (best === null || hullTotal(st.hullStock) > hullTotal(best.hullStock)) best = st;
  }
  return best;
}

function readConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const bands = H.parseSecurityBands(cfg.securityBands);
  const kinds = H.parseFactionKinds(cfg.factionKinds);
  const tierWeights = P.parseTierWeights(cfg.tierWeights);
  const affixWeights = P.parseAffixWeights(cfg.affixWeights);
  const typeWeights = P.POWER_TYPES.map((t) => cfg[P.TYPE_WEIGHT_KEY[t]]);
  const counts = ["maxUpscaleSteps", "maxCandidateSystems", "maxOpen", "maxOpenPerFaction", "maxOpenPerType",
    "systemCooldownMs", "plannedTtlMinMs", "plannedTtlMaxMs", "minMineralUnits", "cacheTtlPermille",
    "fleetingTtlPermille"];
  if (!bands || !kinds || !tierWeights || !affixWeights || !counts.every((k) => isCount(cfg[k]))
    || !typeWeights.every((w) => isCount(w) && w <= TYPE_WEIGHT_MAX) || cfg.plannedTtlMinMs > cfg.plannedTtlMaxMs) {
    return null;
  }
  return { bands, kinds, tierWeights, affixWeights, weightOf: new Map(P.POWER_TYPES.map((t, i) => [t, typeWeights[i]])) };
}

function choosePower(facts, cfg, rng) {
  const c = readConfig(cfg);
  if (!c || !facts || !Array.isArray(facts.systems) || !isCount(facts.now) || !rng
    || typeof rng.nextInt !== "function") {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const open = Array.isArray(facts.open) ? facts.open : [];
  const busy = new Set(open.map((r) => r && r.systemId));
  const limited = open.filter((r) => r && (r.layer ? r.layer === LAYER.POWER : P.isPowerType(r.eventType))
    && H.LIMIT_STATES.includes(r.state));
  const byFaction = new Map();
  const byType = new Map();
  for (const r of limited) {
    bump(byFaction, r.factionId);
    bump(byType, r.eventType);
  }
  if (limited.length >= cfg.maxOpen) return { ok: false, reason: "LIMIT" };
  const types = P.POWER_TYPES.filter((t) => c.weightOf.get(t) > 0);
  if (types.length === 0) return { ok: false, reason: "TYPE_OFF" };
  const funding = cfg.fundFromStock === true;

  let best = 0;
  const note = (reason) => {
    best = Math.max(best, P.POWER_REASON_RANK.indexOf(reason));
  };

  const fieldable = new Map();
  const fieldableOf = (factionId) => {
    if (fieldable.has(factionId)) return fieldable.get(factionId);
    const entry = fromMapOrObject(facts.factions, factionId);
    const stations = (entry && Array.isArray(entry.stations) ? entry.stations : [])
      .filter((st) => st && st.state === STATION_ONLINE)
      .sort((a, b) => String(a.stationId).localeCompare(String(b.stationId)));
    const out = [];
    for (const type of types) {
      if ((byType.get(type) || 0) >= cfg.maxOpenPerType) {
        note("LIMIT");
        continue;
      }
      const minerals = P.MINERAL_TYPES.includes(type);
      if ((funding || minerals) && stations.length === 0) {
        note("NO_STATION");
        continue;
      }
      let pool = stations;
      if (minerals) {
        pool = pool.filter((st) => isCount(st.mineralUnits) && st.mineralUnits >= cfg.minMineralUnits);
        if (pool.length === 0) {
          note("NO_MINERALS");
          continue;
        }
      }
      let variants = P.VARIANTS[type];
      if (funding) {
        variants = variants.filter((v) => {
          const min = maxComposition(type, 1, v, cfg.maxUpscaleSteps, cfg);
          return min.ok && fundingStationOf(pool, min.composition) !== null;
        });
        if (variants.length === 0) {
          note("NO_STOCK");
          continue;
        }
      }
      out.push({ type, variants, pool });
    }
    fieldable.set(factionId, out);
    return out;
  };

  const systemsOf = new Map();
  const systems = facts.systems.slice(0, cfg.maxCandidateSystems).filter((s) => s && isId(s.systemId))
    .sort((a, b) => a.systemId - b.systemId);
  for (const sys of systems) {
    if (!c.bands.includes(sys.band)) {
      note("BAND_OFF");
      continue;
    }
    if (!isId(sys.controllerFactionId)) {
      note("NO_CANDIDATE");
      continue;
    }
    if (!c.kinds.includes(sys.controllerKind)) {
      note("KIND_OFF");
      continue;
    }
    if (busy.has(sys.systemId)) {
      note("BUSY");
      continue;
    }
    const ended = fromMapOrObject(facts.lastPowerEndedAt, sys.systemId);
    if (isCount(ended) && ended + cfg.systemCooldownMs > facts.now) {
      note("COOLDOWN");
      continue;
    }
    const factionId = sys.controllerFactionId;
    if ((byFaction.get(factionId) || 0) >= cfg.maxOpenPerFaction) {
      note("LIMIT");
      continue;
    }
    if (fieldableOf(factionId).length === 0) continue;
    if (!systemsOf.has(factionId)) systemsOf.set(factionId, []);
    systemsOf.get(factionId).push(sys.systemId);
  }
  if (systemsOf.size === 0) return { ok: false, reason: P.POWER_REASON_RANK[best] };

  const factionIds = [...systemsOf.keys()].sort((a, b) => a - b);
  const factionId = factionIds[rng.nextInt(0, factionIds.length - 1)];
  const sysIds = systemsOf.get(factionId);
  const systemId = sysIds[rng.nextInt(0, sysIds.length - 1)];
  const options = fieldableOf(factionId);
  const pick = options[drawIndex(options.map((o) => c.weightOf.get(o.type)), rng)];
  const variant = pick.variants[rng.nextInt(0, pick.variants.length - 1)];
  let tier = Math.min(drawIndex(c.tierWeights, rng) + 1, P.TIER_COUNT);
  let comp = maxComposition(pick.type, tier, variant, cfg.maxUpscaleSteps, cfg);
  let station = null;
  if (funding) {
    station = comp.ok ? fundingStationOf(pick.pool, comp.composition) : null;
    while (station === null && tier > 1) {
      tier -= 1;
      comp = maxComposition(pick.type, tier, variant, cfg.maxUpscaleSteps, cfg);
      station = comp.ok ? fundingStationOf(pick.pool, comp.composition) : null;
    }
    if (station === null) return { ok: false, reason: comp.ok ? "NO_STOCK" : "INVALID_INPUT" };
  }
  if (!comp.ok) return { ok: false, reason: "INVALID_INPUT" };
  const affix = P.AFFIXES[drawIndex(c.affixWeights, rng)];
  const def = tierDefOf(pick.type, tier, variant).def;
  const typePermille = def.ttlPermilleKey ? cfg[def.ttlPermilleKey] : def.ttlPermille;
  let ttlMs = Math.floor((rng.nextInt(cfg.plannedTtlMinMs, cfg.plannedTtlMaxMs) * typePermille) / PERMILLE);
  if (affix === P.AFFIX.FLEETING) ttlMs = Math.floor((ttlMs * cfg.fleetingTtlPermille) / PERMILLE);
  return { ok: true, candidate: { systemId, factionId, eventType: pick.type, variant, tier, affix,
    stationId: station ? station.stationId : null, funded: station !== null, composition: comp.composition,
    total: comp.total, ttlMs, pocketCount: pocketCountOf(pick.type, tier, variant, cfg) } };
}

function labelOf(factionName, eventType, affix) {
  const name = Object.prototype.hasOwnProperty.call(P.LABEL_WORDS, eventType) ? P.LABEL_WORDS[eventType] : "";
  const word = Object.prototype.hasOwnProperty.call(P.AFFIX_WORDS, affix) ? P.AFFIX_WORDS[affix] : "";
  const faction = typeof factionName === "string" ? factionName.trim() : "";
  const join = (...parts) => parts.filter((s) => s !== "").join(" ");
  const full = join(faction, word, name);
  if (full.length <= P.LABEL_MAX) return full;
  const plain = join(faction, name);
  if (plain.length <= P.LABEL_MAX) return plain;
  const room = P.LABEL_MAX - name.length - (name === "" ? 0 : 1);
  return room > 0 ? join(faction.slice(0, room).trim(), name) : name.slice(0, P.LABEL_MAX);
}

module.exports = { choosePower, labelOf, fundingStationOf };
