"use strict";

const { STATION_STATES } = require("../../stations/schema");
const { HELD_STATES } = require("../../world/occupation/schema");
const H = require("../schema");
const { maxComposition, visibilityOfPocket } = require("../power/catalog");
const { fundingStationOf } = require("../power/choose");
const { LAYER } = require("../layer");
const W = require("./schema");
const { META } = require("./catalog");

const STATION_ONLINE = STATION_STATES[0];
const PERMILLE = 1000;
const KIND_WEIGHT_MAX = 100;

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

function readConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const bands = H.parseSecurityBands(cfg.securityBands);
  const kinds = H.parseFactionKinds(cfg.factionKinds);
  const hideoutKinds = H.parseFactionKinds(cfg.hideoutFactionKinds);
  const thresholds = W.parseThresholds(cfg.warcampTierLosses);
  const tierWeightsOf = new Map(Object.entries(W.KIND_TIER_WEIGHTS_KEY)
    .map(([kind, key]) => [kind, W.parseTierWeights(cfg[key])]));
  const stagingFactions = W.parseFactionIdList(cfg.stagingFactions);
  const beneficiaryKinds = H.parseFactionKinds(cfg.stagingBeneficiaryKinds);
  const desertersKinds = H.parseFactionKinds(cfg.desertersFactionKinds);
  const smugglingVictimKinds = H.parseFactionKinds(cfg.smugglingVictimKinds);
  const smugglingKinds = H.parseFactionKinds(cfg.smugglingFactionKinds);
  const frontdepotKinds = H.parseFactionKinds(cfg.frontdepotFactionKinds);
  const frontdepotOperationTypes = W.parseOperationTypes(cfg.frontdepotOperationTypes);
  const wreckedconvoyKinds = H.parseFactionKinds(cfg.wreckedconvoyFactionKinds);
  const flagwreckKinds = H.parseFactionKinds(cfg.flagwreckFactionKinds);
  const weights = W.KINDS.map((k) => cfg[W.KIND_WEIGHT_KEY[k]]);
  const counts = ["maxUpscaleSteps", "maxCandidateSystems", "maxOpen", "maxOpenPerFaction", "maxOpenPerKind",
    "systemCooldownMs", "plannedTtlMinMs", "plannedTtlMaxMs", "warcampMinLosses", "desertersMinUnpaidDays",
    "wreckedconvoyMinLostUnits", "flagwreckMinCapitals", "breachMinPressureMilli"];
  if (!bands || !kinds || !hideoutKinds || !thresholds || [...tierWeightsOf.values()].some((w) => !w)
    || !stagingFactions || !beneficiaryKinds || !desertersKinds || !smugglingVictimKinds || !smugglingKinds
    || !frontdepotKinds || !frontdepotOperationTypes || !wreckedconvoyKinds || !flagwreckKinds
    || !isId(cfg.breachFactionId) || !counts.every((k) => isCount(cfg[k]))
    || !weights.every((w) => isCount(w) && w <= KIND_WEIGHT_MAX) || cfg.plannedTtlMinMs > cfg.plannedTtlMaxMs) {
    return null;
  }
  return { bands, kinds, hideoutKinds, thresholds, tierWeightsOf, stagingFactions, beneficiaryKinds, desertersKinds,
    smugglingVictimKinds, smugglingKinds, frontdepotKinds, frontdepotOperationTypes, wreckedconvoyKinds,
    flagwreckKinds, breachFactionId: cfg.breachFactionId,
    weightOf: new Map(W.KINDS.map((k, i) => [k, weights[i]])) };
}

function noTriggerOf(facts, reasons) {
  const refused = facts && facts.readRefusedKinds instanceof Set ? facts.readRefusedKinds : null;
  return (kind) => {
    if (!refused || !refused.has(kind)) reasons.push("NO_TRIGGER");
  };
}

const sortedIds = (list) => [...new Set((Array.isArray(list) ? list : []).filter(isId))].sort((a, b) => a - b);

function economyTriggersOf(sys, facts, cfg, c, kindOf, byKind, reasons) {
  const at = (list) => (Array.isArray(list) ? list : []).filter((x) => x && x.systemId === sys.systemId
    && isId(x.factionId));
  const noTrigger = noTriggerOf(facts, reasons);
  if (c.weightOf.get(W.KIND.DESERTERS) > 0) {
    const ctrl = sys.controllerFactionId;
    const t = isId(ctrl) ? fromMapOrObject(facts.treasury, ctrl) : undefined;
    if (!isId(ctrl)) {
      noTrigger(W.KIND.DESERTERS);
    } else if (!c.desertersKinds.includes(kindOf(ctrl))) {
      reasons.push("KIND_OFF");
    } else if (!t || !isCount(t.unpaidDays) || t.unpaidDays < cfg.desertersMinUnpaidDays) {
      noTrigger(W.KIND.DESERTERS);
    } else {
      byKind.get(W.KIND.DESERTERS).push({ systemId: sys.systemId, factionId: ctrl, tier: null });
    }
  }
  if (c.weightOf.get(W.KIND.SMUGGLING) > 0) {
    const victims = sortedIds(at(facts.starved).map((x) => x.factionId))
      .filter((v) => c.smugglingVictimKinds.includes(kindOf(v)));
    const pirates = sortedIds(fromMapOrObject(facts.neighborControllers, sys.systemId))
      .filter((p) => c.smugglingKinds.includes(kindOf(p)));
    const found = pirates.filter((p) => victims.some((v) => v !== p));
    if (found.length === 0) noTrigger(W.KIND.SMUGGLING);
    for (const p of found) byKind.get(W.KIND.SMUGGLING).push({ systemId: sys.systemId, factionId: p, tier: null });
  }
  if (c.weightOf.get(W.KIND.FRONTDEPOT) > 0) {
    const fronts = at(facts.fronts);
    if (fronts.length === 0) noTrigger(W.KIND.FRONTDEPOT);
    for (const f of sortedIds(fronts.map((x) => x.factionId))) {
      if (!c.frontdepotKinds.includes(kindOf(f))) {
        reasons.push("KIND_OFF");
        continue;
      }
      const first = fronts.filter((x) => x.factionId === f)
        .sort((a, b) => String(a.operationId).localeCompare(String(b.operationId)))[0];
      const cand = { systemId: sys.systemId, factionId: f, tier: null };
      if (isId(first.originSystemId)) cand.preferSystemId = first.originSystemId;
      byKind.get(W.KIND.FRONTDEPOT).push(cand);
    }
  }
  if (c.weightOf.get(W.KIND.WRECKEDCONVOY) > 0) {
    const here = at(facts.lostConvoys).filter((x) => isCount(x.lostUnits)
      && x.lostUnits >= cfg.wreckedconvoyMinLostUnits).sort((a, b) => a.factionId - b.factionId);
    if (here.length === 0) noTrigger(W.KIND.WRECKEDCONVOY);
    for (const x of here) {
      if (!c.wreckedconvoyKinds.includes(kindOf(x.factionId))) {
        reasons.push("KIND_OFF");
        continue;
      }
      byKind.get(W.KIND.WRECKEDCONVOY).push({ systemId: sys.systemId, factionId: x.factionId, tier: null });
    }
  }
}

function sub6TriggersOf(sys, facts, cfg, c, kindOf, byKind, reasons) {
  const noTrigger = noTriggerOf(facts, reasons);
  if (c.weightOf.get(W.KIND.FLAGWRECK) > 0) {
    const here = (Array.isArray(facts.capitalLosses) ? facts.capitalLosses : []).filter((l) => l
      && l.systemId === sys.systemId && isId(l.factionId) && isCount(l.count) && l.count >= cfg.flagwreckMinCapitals)
      .sort((a, b) => a.factionId - b.factionId);
    const salvage = facts.salvageSystems instanceof Set ? facts.salvageSystems : new Set();
    if (here.length === 0) {
      noTrigger(W.KIND.FLAGWRECK);
    } else if (salvage.has(sys.systemId)) {
      reasons.push("BUSY");
    } else {
      for (const l of here) {
        if (!c.flagwreckKinds.includes(kindOf(l.factionId))) {
          reasons.push("KIND_OFF");
          continue;
        }
        byKind.get(W.KIND.FLAGWRECK).push({ systemId: sys.systemId, factionId: l.factionId, tier: W.TIER_COUNT });
      }
    }
  }
  if (c.weightOf.get(W.KIND.BREACH) > 0) {
    const milli = fromMapOrObject(facts.pressure, sys.systemId);
    if (!isCount(milli) || milli < cfg.breachMinPressureMilli) {
      noTrigger(W.KIND.BREACH);
    } else {
      byKind.get(W.KIND.BREACH).push({ systemId: sys.systemId, factionId: c.breachFactionId, tier: null });
    }
  }
}

function defenderOf(system, invaderId, kindOf, beneficiaryKinds) {
  if (!system || typeof kindOf !== "function" || !Array.isArray(beneficiaryKinds)) return null;
  const pick = [system.controllerFactionId, system.previousControllerFactionId]
    .find((id) => isId(id) && id !== invaderId);
  if (pick === undefined) return null;
  return beneficiaryKinds.includes(kindOf(pick)) ? pick : null;
}

const warcampTierOf = (count, thresholds) => Math.max(1, thresholds.filter((t) => count >= t).length);

function triggersOf(facts, cfg) {
  const c = readConfig(cfg);
  const byKind = new Map(W.KINDS.map((k) => [k, []]));
  const reasons = [];
  if (!c || !facts || !Array.isArray(facts.systems)) return { byKind, reasons: ["NO_CANDIDATE"] };
  const kindOf = (factionId) => {
    const v = fromMapOrObject(facts.kindOf, factionId);
    return typeof v === "string" ? v : null;
  };
  const systems = facts.systems.slice(0, cfg.maxCandidateSystems).filter((s) => s && isId(s.systemId))
    .sort((a, b) => a.systemId - b.systemId);
  const losses = Array.isArray(facts.losses) ? facts.losses : [];
  const beachheads = Array.isArray(facts.beachheads) ? facts.beachheads : [];
  const noTrigger = noTriggerOf(facts, reasons);
  for (const sys of systems) {
    if (!c.bands.includes(sys.band)) {
      reasons.push("BAND_OFF");
      continue;
    }
    if (c.weightOf.get(W.KIND.WARCAMP) > 0) {
      const here = losses.filter((l) => l && l.systemId === sys.systemId && isId(l.factionId) && isCount(l.count)
        && l.count >= cfg.warcampMinLosses).sort((a, b) => a.factionId - b.factionId);
      if (here.length === 0) noTrigger(W.KIND.WARCAMP);
      for (const l of here) {
        if (!c.kinds.includes(kindOf(l.factionId))) {
          reasons.push("KIND_OFF");
          continue;
        }
        byKind.get(W.KIND.WARCAMP).push({ systemId: sys.systemId, factionId: l.factionId,
          tier: warcampTierOf(l.count, c.thresholds) });
      }
    }
    if (c.weightOf.get(W.KIND.HIDEOUT) > 0) {
      const occupier = sys.occupierFactionId;
      if (!HELD_STATES.includes(sys.occupationState) || !isId(occupier)) {
        reasons.push("NO_TRIGGER");
      } else if (!c.hideoutKinds.includes(kindOf(occupier))) {
        reasons.push("KIND_OFF");
      } else {
        byKind.get(W.KIND.HIDEOUT).push({ systemId: sys.systemId, factionId: occupier, tier: null });
      }
    }
    if (c.weightOf.get(W.KIND.STAGING) > 0) {
      const here = beachheads.filter((b) => b && b.systemId === sys.systemId && isId(b.factionId))
        .sort((a, b) => a.factionId - b.factionId);
      if (here.length === 0) noTrigger(W.KIND.STAGING);
      for (const b of here) {
        if (!c.stagingFactions.includes(b.factionId)) {
          reasons.push("KIND_OFF");
          continue;
        }
        byKind.get(W.KIND.STAGING).push({ systemId: sys.systemId, factionId: b.factionId, tier: null,
          beneficiaryFactionId: defenderOf(sys, b.factionId, kindOf, c.beneficiaryKinds) });
      }
    }
    economyTriggersOf(sys, facts, cfg, c, kindOf, byKind, reasons);
    sub6TriggersOf(sys, facts, cfg, c, kindOf, byKind, reasons);
  }
  return { byKind, reasons };
}

function chooseWorld(facts, cfg, rng) {
  const c = readConfig(cfg);
  if (!c || !facts || !Array.isArray(facts.systems) || !isCount(facts.now) || !rng
    || typeof rng.nextInt !== "function") {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const open = Array.isArray(facts.open) ? facts.open : [];
  const busy = new Set(open.map((r) => r && r.systemId));
  const limited = open.filter((r) => r && r.layer === LAYER.WORLD && H.LIMIT_STATES.includes(r.state));
  const byFaction = new Map();
  const byKind = new Map();
  for (const r of limited) {
    bump(byFaction, r.factionId);
    bump(byKind, r.variant);
  }
  if (limited.length >= cfg.maxOpen) return { ok: false, reason: "LIMIT" };
  if (!W.KINDS.some((k) => c.weightOf.get(k) > 0)) return { ok: false, reason: "TYPE_OFF" };
  const funding = cfg.fundFromStock === true;

  let best = 0;
  const note = (reason) => {
    best = Math.max(best, W.WORLD_REASON_RANK.indexOf(reason));
  };

  const poolOf = (factionId) => {
    const entry = fromMapOrObject(facts.factions, factionId);
    return (entry && Array.isArray(entry.stations) ? entry.stations : [])
      .filter((st) => st && st.state === STATION_ONLINE)
      .sort((a, b) => String(a.stationId).localeCompare(String(b.stationId)));
  };
  const fundOf = (pool, composition, preferSystemId) => {
    if (isId(preferSystemId)) {
      const preferred = pool.filter((st) => st.systemId === preferSystemId);
      const hit = preferred.length > 0 ? fundingStationOf(preferred, composition) : null;
      if (hit !== null) return hit;
    }
    return fundingStationOf(pool, composition);
  };

  const trig = triggersOf(facts, cfg);
  for (const reason of trig.reasons) note(reason);
  const options = [];
  for (const kind of W.KINDS) {
    const found = trig.byKind.get(kind);
    if (found.length === 0) continue;
    if ((byKind.get(kind) || 0) >= cfg.maxOpenPerKind) {
      note("LIMIT");
      continue;
    }
    const eventType = W.MECHANIC_OF[kind];
    const funds = funding && !W.SYNTHETIC_KINDS.includes(kind);
    const kept = [];
    for (const cand of found) {
      if (busy.has(cand.systemId)) {
        note("BUSY");
        continue;
      }
      const ended = fromMapOrObject(facts.lastWorldEndedAt, cand.systemId);
      if (isCount(ended) && ended + cfg.systemCooldownMs > facts.now) {
        note("COOLDOWN");
        continue;
      }
      if ((byFaction.get(cand.factionId) || 0) >= cfg.maxOpenPerFaction) {
        note("LIMIT");
        continue;
      }
      if (funds) {
        const pool = poolOf(cand.factionId);
        if (pool.length === 0) {
          note("NO_STATION");
          continue;
        }
        const min = maxComposition(eventType, 1, kind, cfg.maxUpscaleSteps, cfg);
        if (!min.ok || fundOf(pool, min.composition, cand.preferSystemId) === null) {
          note("NO_STOCK");
          continue;
        }
      }
      kept.push(cand);
    }
    if (kept.length === 0) continue;
    kept.sort((a, b) => a.systemId - b.systemId || a.factionId - b.factionId);
    options.push({ kind, eventType, candidates: kept });
  }
  if (options.length === 0) return { ok: false, reason: W.WORLD_REASON_RANK[best] };

  const pick = options[drawIndex(options.map((o) => c.weightOf.get(o.kind)), rng)];
  const cand = pick.candidates[rng.nextInt(0, pick.candidates.length - 1)];
  let tier = cand.tier === null ? Math.min(drawIndex(c.tierWeightsOf.get(pick.kind), rng) + 1, W.TIER_COUNT)
    : Math.min(cand.tier, W.TIER_COUNT);
  let comp = maxComposition(pick.eventType, tier, pick.kind, cfg.maxUpscaleSteps, cfg);
  let station = null;
  if (funding && !W.SYNTHETIC_KINDS.includes(pick.kind)) {
    const pool = poolOf(cand.factionId);
    station = comp.ok ? fundOf(pool, comp.composition, cand.preferSystemId) : null;
    while (station === null && tier > 1) {
      tier -= 1;
      comp = maxComposition(pick.eventType, tier, pick.kind, cfg.maxUpscaleSteps, cfg);
      station = comp.ok ? fundOf(pool, comp.composition, cand.preferSystemId) : null;
    }
    if (station === null) return { ok: false, reason: comp.ok ? "NO_STOCK" : "INVALID_INPUT" };
  }
  if (!comp.ok) return { ok: false, reason: "INVALID_INPUT" };
  const siteKind = visibilityOfPocket(pick.eventType, tier, pick.kind, 0, cfg);
  if (siteKind === null) return { ok: false, reason: "INVALID_INPUT" };
  const ttlMs = Math.floor((rng.nextInt(cfg.plannedTtlMinMs, cfg.plannedTtlMaxMs) * META[pick.kind].ttlPermille)
    / PERMILLE);
  return { ok: true, candidate: { kind: pick.kind, eventType: pick.eventType, variant: pick.kind,
    affix: W.AFFIX_NONE, systemId: cand.systemId, factionId: cand.factionId, tier,
    stationId: station ? station.stationId : null, funded: station !== null, composition: comp.composition,
    total: comp.total, ttlMs, siteKind,
    beneficiaryFactionId: isId(cand.beneficiaryFactionId) ? cand.beneficiaryFactionId : null } };
}

function labelOf(factionName, kind) {
  const name = Object.prototype.hasOwnProperty.call(W.LABEL_WORDS, kind) ? W.LABEL_WORDS[kind] : "";
  const faction = typeof factionName === "string" ? factionName.trim() : "";
  const full = [faction, name].filter((s) => s !== "").join(" ");
  if (full.length <= W.LABEL_MAX) return full;
  const room = W.LABEL_MAX - name.length - (name === "" ? 0 : 1);
  return room > 0 ? `${faction.slice(0, room).trim()} ${name}`.trim() : name.slice(0, W.LABEL_MAX);
}

module.exports = { chooseWorld, triggersOf, labelOf, warcampTierOf, defenderOf };
