"use strict";

const { CLAIM_STATES } = require("../world/occupation/schema");
const { STATION_STATES } = require("../stations/schema");
const S = require("./schema");
const { maxComposition, tierCountOf } = require("./catalog");

const STATION_ONLINE = STATION_STATES[0];

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

function stockCovers(stock, composition) {
  return composition.every((x) => stock && isCount(stock[x.hullGroup]) && stock[x.hullGroup] >= x.count);
}

const lastEndedOf = (facts, systemId) => {
  const src = facts.lastEndedAt;
  if (src instanceof Map) return src.get(systemId);
  return src && Object.prototype.hasOwnProperty.call(src, systemId) ? src[systemId] : undefined;
};

function drawTier(weights, rng, type) {
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = rng.nextInt(0, sum - 1);
  let tier = weights.length;
  for (let i = 0; i < weights.length; i += 1) {
    if (r < weights[i]) {
      tier = i + 1;
      break;
    }
    r -= weights[i];
  }
  return Math.min(tier, tierCountOf(type));
}

function chooseCandidate(facts, cfg, rng) {
  const bands = cfg ? S.parseSecurityBands(cfg.securityBands) : null;
  const kinds = cfg ? S.parseFactionKinds(cfg.factionKinds) : null;
  const weights = cfg ? S.parseTierWeights(cfg.tierWeights) : null;
  if (!facts || !Array.isArray(facts.systems) || !isCount(facts.now) || !bands || !kinds || !weights || !rng
    || !isCount(cfg.maxUpscaleSteps)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const waveParams = { defenseWaves: cfg.defenseWaves, waveGrowthPermille: cfg.waveGrowthPermille };
  const open = Array.isArray(facts.open) ? facts.open : [];
  const busy = new Set(open.map((r) => r.systemId));
  const limited = open.filter((r) => S.HEAVY_TYPES.includes(r.eventType) && S.LIMIT_STATES.includes(r.state));
  const byFaction = new Map();
  const byType = new Map();
  for (const r of limited) {
    bump(byFaction, r.factionId);
    bump(byType, r.eventType);
  }
  if (limited.length >= cfg.maxOpen) return { ok: false, reason: "LIMIT" };
  const types = S.HEAVY_TYPES.filter((t) => cfg[S.TYPE_SWITCH_KEY[t]] === true);
  if (types.length === 0) return { ok: false, reason: "TYPE_OFF" };
  const funding = cfg.fundFromStock === true;
  const minimum = new Map(types.map((t) => [t, maxComposition(t, 1, cfg.maxUpscaleSteps, waveParams)]));

  let best = 0;
  const note = (reason) => {
    best = Math.max(best, S.CANDIDATE_REASON_RANK.indexOf(reason));
  };
  const eligible = [];
  const systems = facts.systems.slice(0, cfg.maxCandidateSystems).filter((s) => s && isId(s.systemId))
    .sort((a, b) => a.systemId - b.systemId);
  for (const sys of systems) {
    if (!bands.includes(sys.band)) {
      note("BAND_OFF");
      continue;
    }
    if (busy.has(sys.systemId)) {
      note("BUSY");
      continue;
    }
    const ended = lastEndedOf(facts, sys.systemId);
    if (isCount(ended) && ended + cfg.systemCooldownMs > facts.now) {
      note("COOLDOWN");
      continue;
    }
    const stations = (Array.isArray(sys.stations) ? sys.stations : [])
      .filter((st) => st && st.state === STATION_ONLINE && isId(st.factionId))
      .sort((a, b) => String(a.stationId).localeCompare(String(b.stationId)));
    for (const type of types) {
      const min = minimum.get(type);
      if (!min.ok) continue;
      let factionId;
      let kind;
      let beneficiaryFactionId = null;
      const occ = sys.occupation;
      if (type === S.TYPE.DEFENSE) {
        if (!occ || !CLAIM_STATES.includes(occ.state) || !isId(occ.occupierFactionId) || !isId(sys.controllerFactionId)
          || occ.occupierFactionId === sys.controllerFactionId) {
          note("NO_CANDIDATE");
          continue;
        }
        factionId = occ.occupierFactionId;
        kind = occ.occupierKind;
        beneficiaryFactionId = sys.controllerFactionId;
      } else {
        if (!isId(sys.controllerFactionId)) {
          note("NO_CANDIDATE");
          continue;
        }
        factionId = sys.controllerFactionId;
        kind = sys.controllerKind;
      }
      const kindOk = type === S.TYPE.DEFENSE ? S.FACTION_KINDS.includes(kind) && kind !== S.NEUTRAL_KIND
        : kinds.includes(kind);
      if (!kindOk) {
        note("KIND_OFF");
        continue;
      }
      const owner = beneficiaryFactionId === null ? factionId : beneficiaryFactionId;
      let pool = stations.filter((st) => st.factionId === owner);
      if (pool.length === 0) {
        note("NO_STATION");
        continue;
      }
      if (type === S.TYPE.FOUNDRY) {
        pool = pool.filter((st) => isCount(st.mineralUnits) && st.mineralUnits >= cfg.foundryMinMineralUnits);
        if (pool.length === 0) {
          note("NO_MINERALS");
          continue;
        }
      }
      const funded = funding && S.FUNDED_TYPES.includes(type);
      if (funded) {
        pool = pool.filter((st) => stockCovers(st.hullStock, min.composition));
        if (pool.length === 0) {
          note("NO_STOCK");
          continue;
        }
      }
      if ((byFaction.get(factionId) || 0) >= cfg.maxOpenPerFaction || (byType.get(type) || 0) >= cfg.maxOpenPerType) {
        note("LIMIT");
        continue;
      }
      eligible.push({ systemId: sys.systemId, eventType: type, factionId, beneficiaryFactionId, station: pool[0],
        funded });
    }
  }
  if (eligible.length === 0) return { ok: false, reason: S.CANDIDATE_REASON_RANK[best] };

  const pick = eligible[rng.nextInt(0, eligible.length - 1)];
  let tier = drawTier(weights, rng, pick.eventType);
  let comp = maxComposition(pick.eventType, tier, cfg.maxUpscaleSteps, waveParams);
  while (pick.funded && tier > 1 && !(comp.ok && stockCovers(pick.station.hullStock, comp.composition))) {
    tier -= 1;
    comp = maxComposition(pick.eventType, tier, cfg.maxUpscaleSteps, waveParams);
  }
  if (!comp.ok) return { ok: false, reason: "INVALID_INPUT" };
  return { ok: true, candidate: { systemId: pick.systemId, eventType: pick.eventType, tier,
    factionId: pick.factionId, beneficiaryFactionId: pick.beneficiaryFactionId, stationId: pick.station.stationId,
    funded: pick.funded, composition: comp.composition, total: comp.total } };
}

module.exports = { chooseCandidate, stockCovers };
