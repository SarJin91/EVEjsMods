"use strict";

const { deriveSeed, createRng } = require("../../util/rng");
const { hullDeltas } = require("../../stations/stockKeys");
const { STATION_STATES } = require("../../stations/schema");
const H = require("../schema");
const P = require("./schema");
const PC = require("./catalog");
const { choosePower, labelOf } = require("./choose");
const { nearSystems, stationsRepoOf, stockFactsOf, refusalOf, Rollback } = require("../planner");
const { LAYER, layerOfEventId } = require("../layer");

const STATION_ONLINE = STATION_STATES[0];
const SITE_SLOT = 0;
const FUND_REASON = "heavy_event_fund";
const SEED_PREFIX = "hpw:";

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
};

const sizeOf = (part) => part.reduce((a, x) => a + x.count, 0);

function chooseConfigOf(env) {
  const cfg = { ...env.power, maxUpscaleSteps: env.settings.maxUpscaleSteps };
  for (const type of P.POWER_TYPES) if (!P.POWER_LIVE_READY.includes(type)) cfg[P.TYPE_WEIGHT_KEY[type]] = 0;
  return cfg;
}

function peakOf(type, tier, variant, cfg) {
  const r = PC.phasesOf(type, tier, variant, cfg);
  if (!r.ok) return null;
  return Math.max(...r.phases.map(sizeOf)) + cfg.maxUpscaleSteps * sizeOf(r.def.scaling);
}

function capPeak(candidate, cfg, station) {
  for (let tier = candidate.tier; tier >= 1; tier -= 1) {
    const peak = peakOf(candidate.eventType, tier, candidate.variant, cfg);
    if (peak === null || peak > cfg.maxShipsPerEvent) continue;
    if (tier === candidate.tier) return candidate;
    const comp = PC.maxComposition(candidate.eventType, tier, candidate.variant, cfg.maxUpscaleSteps, cfg);
    if (!comp.ok) continue;
    if (candidate.funded && !(station && comp.composition.every((x) => (station.hullStock[x.hullGroup] || 0)
      >= x.count))) {
      continue;
    }
    return { ...candidate, tier, composition: comp.composition, total: comp.total };
  }
  return null;
}

function readFactsInTx(tx, env, near, eventIds, now) {
  for (const eventId of eventIds) {
    const existing = env.repo.getInTx(tx, eventId);
    if (!existing.ok) throw new Rollback("OTHER", existing.reason);
    if (existing.row) return { duplicate: true };
  }
  const stations = stationsRepoOf(env);
  if (!stations) throw new Rollback("STATIONS_NOT_READY");
  const worldRepo = safe(() => env.getWorldRepository(), null);
  if (!worldRepo || typeof worldRepo.getSystem !== "function") throw new Rollback("OTHER", "WORLD_NOT_READY");
  const kinds = H.parseFactionKinds(env.power.factionKinds) || [];
  const systems = [];
  for (const sys of near) {
    if (systems.length >= env.power.maxCandidateSystems) break;
    const w = worldRepo.getSystem(tx, sys.systemId, { includeInfluence: false });
    const system = w && w.ok === true && w.system ? w.system : null;
    const controller = system ? system.controllerFactionId : null;
    if (!Number.isSafeInteger(controller) || controller <= 0) continue;
    const kind = safe(() => env.getFactionKind(controller), null);
    if (!kinds.includes(kind)) continue;
    systems.push({ systemId: sys.systemId, band: sys.band, controllerFactionId: controller, controllerKind: kind });
  }
  const factions = new Map();
  for (const factionId of [...new Set(systems.map((x) => x.controllerFactionId))].sort((a, b) => a - b)) {
    const listed = stations.listStationsOfFaction(tx, factionId, { states: [STATION_ONLINE] });
    if (!listed || listed.ok !== true) throw new Rollback("OTHER", (listed && listed.reason) || "STATION_READ_FAILED");
    const records = listed.records.filter((r) => r.state === STATION_ONLINE);
    const stocks = records.length > 0 ? stations.getStocks(tx, records.map((r) => r.stationId)) : null;
    if (stocks && stocks.ok !== true) throw new Rollback("OTHER", stocks.reason || "STOCK_READ_FAILED");
    factions.set(factionId, { stations: records.map((r) => {
      const st = stocks ? stocks.byStation.get(r.stationId) : null;
      return { stationId: r.stationId, state: r.state, ...stockFactsOf(st ? st.items : []) };
    }) });
  }
  const lastPowerEndedAt = new Map();
  for (const sys of systems) {
    const ended = env.repo.lastEndedInSystemInTx(tx, sys.systemId, { types: P.POWER_TYPES, layer: LAYER.POWER });
    if (!ended.ok) throw new Rollback("OTHER", ended.reason);
    if (ended.endedAt !== null) lastPowerEndedAt.set(sys.systemId, ended.endedAt);
  }
  const open = env.repo.listOpenInTx(tx, { limit: H.OPEN_SCAN_LIMIT });
  if (!open.ok) throw new Rollback("OTHER", open.reason);
  return { duplicate: false, facts: { now, systems, factions, lastPowerEndedAt,
    open: open.rows.map((r) => ({ systemId: r.systemId, factionId: r.factionId, eventType: r.eventType,
      state: r.state, layer: layerOfEventId(r.eventId) })) } };
}

function writePlanInTx(tx, env, plan, now) {
  const { eventId, planKey, candidate, members, seed, expiresAt, label, siteKind } = plan;
  const existing = env.repo.getInTx(tx, eventId);
  if (!existing.ok) throw new Rollback("OTHER", existing.reason);
  if (existing.row) return { duplicate: true };
  if (candidate.funded) {
    const stations = stationsRepoOf(env);
    if (!stations) throw new Rollback("STATIONS_NOT_READY");
    const deltas = hullDeltas(candidate.composition, -1);
    if (!deltas.ok) throw new Rollback("OTHER", deltas.reason);
    const fund = stations.applyStockChange(tx, { stationId: candidate.stationId, key: H.fundKeyOf(eventId),
      reason: FUND_REASON, at: now, deltas: deltas.deltas });
    if (!fund || fund.ok !== true) throw new Rollback((fund && fund.reason) || "OTHER");
  }
  const planned = env.repo.planInTx(tx, { eventId, planKey, eventType: candidate.eventType, tier: candidate.tier,
    systemId: candidate.systemId, factionId: candidate.factionId, beneficiaryFactionId: null,
    stationId: candidate.stationId, members, funded: candidate.funded, integrity: null, seed, at: now, expiresAt,
    dueAt: expiresAt, variant: candidate.variant, affix: candidate.affix });
  if (!planned.ok) throw new Rollback("OTHER", planned.reason);
  if (planned.duplicate) throw new Rollback("OTHER", "PLAN_DUPLICATE");
  const sites = safe(() => env.getSites(), null);
  if (!sites || typeof sites.createSiteInTx !== "function") throw new Rollback("OTHER", "SITES_UNAVAILABLE");
  const site = sites.createSiteInTx(tx, { eventId, slot: SITE_SLOT, systemId: candidate.systemId,
    templateId: env.settings.beaconTemplateId, label, factionId: candidate.factionId,
    expiresAt: expiresAt + env.settings.engagedMaxMs + env.settings.aftermathMs, siteKind });
  if (!site || site.ok !== true) throw new Rollback((site && site.reason) || "OTHER");
  return { duplicate: false };
}

function takeIntoFacts(facts, candidate) {
  facts.open.push({ systemId: candidate.systemId, factionId: candidate.factionId, eventType: candidate.eventType,
    state: H.STATE.PLANNED, layer: LAYER.POWER });
  if (!candidate.funded) return;
  const entry = facts.factions.get(candidate.factionId);
  const station = entry ? entry.stations.find((st) => st.stationId === candidate.stationId) : null;
  if (!station) return;
  const stock = { ...station.hullStock };
  for (const x of candidate.composition) stock[x.hullGroup] = (stock[x.hullGroup] || 0) - x.count;
  station.hullStock = stock;
}

function planPowerPass(env, now, bucket) {
  const ps = env.power;
  const slots = [];
  for (let slot = 0; slot < ps.maxPlansPerPass; slot += 1) {
    slots.push({ eventId: P.eventIdOf(bucket, slot), planKey: P.planKeyOf(ps.planIntervalMs, bucket, slot) });
  }
  const bands = H.parseSecurityBands(ps.securityBands) || [];
  const near = nearSystems({ ...env, settings: ps }, bands);
  if (!near.ok) return { ok: false, reason: near.reason };
  if (!stationsRepoOf(env)) return { ok: false, reason: "STATIONS_NOT_READY" };
  const sites = safe(() => env.getSites(), null);
  const live = sites && typeof sites.countLive === "function" ? safe(() => sites.countLive(), null) : null;
  if (!live || live.ok !== true || !Number.isSafeInteger(live.count)) {
    return { ok: false, reason: "OTHER", detail: `SITES_COUNT ${(live && live.reason) || "UNAVAILABLE"}` };
  }
  let liveSites = live.count;
  const free = () => env.maxActiveSites - liveSites;
  if (free() < ps.minFreeSiteSlots) return { ok: false, reason: "SITES_HEADROOM" };

  const read = env.store.transaction("heavyEvents.powerPlanRead", (tx) => readFactsInTx(tx, env, near.systems,
    slots.map((x) => x.eventId), now));
  if (!read.ok) return refusalOf(read);
  if (read.value.duplicate) return { ok: true, outcome: "DUPLICATE", planned: 0, refused: {}, plans: [] };
  const facts = read.value.facts;
  const cfg = chooseConfigOf(env);
  const refused = {};
  const plans = [];
  const note = (reason) => {
    refused[reason] = (refused[reason] || 0) + 1;
  };
  for (const { eventId, planKey } of slots) {
    if (free() < ps.minFreeSiteSlots) {
      note("SITES_HEADROOM");
      break;
    }
    const seed = deriveSeed(env.worldSeed, `${SEED_PREFIX}${planKey}`);
    const choice = choosePower(facts, cfg, createRng(seed));
    if (!choice.ok) {
      note(P.POWER_REASON_RANK.includes(choice.reason) ? choice.reason : "OTHER");
      break;
    }
    const entry = facts.factions.get(choice.candidate.factionId);
    const station = entry ? entry.stations.find((st) => st.stationId === choice.candidate.stationId) : null;
    const candidate = capPeak(choice.candidate, cfg, station);
    if (!candidate) {
      note("SHIPS_CAP");
      continue;
    }
    const members = PC.membersOf(candidate.eventType, candidate.tier, candidate.variant, cfg.maxUpscaleSteps, cfg);
    const siteKind = PC.visibilityOfPocket(candidate.eventType, candidate.tier, candidate.variant, 0, cfg);
    if (!members.ok || siteKind === null) {
      note("OTHER");
      continue;
    }
    const plan = { eventId, planKey, candidate, members: members.members, seed, expiresAt: now + candidate.ttlMs,
      siteKind, label: labelOf(safe(() => env.factionName(candidate.factionId), null), candidate.eventType,
        candidate.affix) };
    const write = env.store.transaction("heavyEvents.powerPlan", (tx) => writePlanInTx(tx, env, plan, now));
    if (!write.ok) {
      note(refusalOf(write).reason);
      continue;
    }
    if (write.value.duplicate) continue;
    liveSites += 1;
    takeIntoFacts(facts, candidate);
    plans.push({ eventId, eventType: candidate.eventType, tier: candidate.tier, variant: candidate.variant,
      affix: candidate.affix, systemId: candidate.systemId, total: candidate.funded ? candidate.total : 0 });
  }
  return { ok: true, outcome: "PLANNED", planned: plans.length, refused, plans };
}

module.exports = { planPowerPass, chooseConfigOf, peakOf, capPeak };
