"use strict";

const { bfs } = require("../ai/bfs");
const { createRng, deriveSeed, stableHash32 } = require("../../util/rng");
const D = require("../data/capsuleers");

const NAME_MAX = 50;
const TICKER_BASE_LENGTH = 3;

function baseTickerOf(slot) {
  const prefix = D.NAME_PREFIXES[(D.NAME_SEED + slot - 1) % D.NAME_PREFIXES.length];
  const suffix = D.NAME_SUFFIXES[stableHash32(D.NAME_SEED, "suffix", slot) % D.NAME_SUFFIXES.length];
  return { prefix, suffix, ticker: `${prefix.slice(0, TICKER_BASE_LENGTH)}${suffix[0]}`.toUpperCase() };
}

let slotTable = null;

function slotTableOf() {
  if (slotTable) return slotTable;
  const table = [null];
  const names = new Set();
  const tickers = new Set();
  for (let s = 1; s <= D.MAX_SLOTS; s += 1) {
    const { prefix } = baseTickerOf(s);
    let index = stableHash32(D.NAME_SEED, "suffix", s) % D.NAME_SUFFIXES.length;
    for (let k = 1; k < D.NAME_SUFFIXES.length && names.has(`${prefix} ${D.NAME_SUFFIXES[index]}`); k += 1) {
      index = (index + 1) % D.NAME_SUFFIXES.length;
    }
    const suffix = D.NAME_SUFFIXES[index];
    const base = `${prefix.slice(0, TICKER_BASE_LENGTH)}${suffix[0]}`.toUpperCase();
    const ticker = tickers.has(base) ? `${base.slice(0, TICKER_BASE_LENGTH)}${s}` : base;
    const name = `${prefix} ${suffix}`.slice(0, NAME_MAX);
    names.add(name);
    tickers.add(ticker);
    table.push(Object.freeze({ name, ticker }));
  }
  slotTable = Object.freeze(table);
  return slotTable;
}

function corpNameOf(slot) {
  const s = Number.isSafeInteger(slot) && slot > 0 ? slot : 1;
  if (s <= D.MAX_SLOTS) {
    const row = slotTableOf()[s];
    return { name: row.name, ticker: row.ticker };
  }
  const own = baseTickerOf(s);
  let ticker = own.ticker;
  for (let other = 1; other < s && other <= D.MAX_SLOTS; other += 1) {
    if (baseTickerOf(other).ticker === own.ticker) {
      ticker = `${own.ticker.slice(0, TICKER_BASE_LENGTH)}${s}`;
      break;
    }
  }
  return { name: `${own.prefix} ${own.suffix}`.slice(0, NAME_MAX), ticker };
}

function planBase(input, params) {
  try {
    const starts = (input.pirateSystemIds || []).filter((id) => Number.isSafeInteger(id) && id > 0);
    if (starts.length === 0) return { ok: false, reason: "NO_PIRATE_SPACE" };
    const reach = bfs(starts, input.neighbors, { maxJumps: params.baseMaxJumpsToPirate,
      maxSystems: params.baseScanMaxSystems });
    const ordered = [...reach.entries()].filter(([, jumps]) => jumps >= 1)
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const taken = input.takenBaseIds instanceof Set ? input.takenBaseIds : new Set();
    const excluded = input.excludedRegionIds instanceof Set ? input.excludedRegionIds : new Set();
    const candidates = [];
    for (const [systemId, jumps] of ordered) {
      if (candidates.length >= params.baseCandidatesTop) break;
      const v = input.vertexOf(systemId);
      if (!v || !params.baseSecClasses.includes(v.secClass) || excluded.has(v.regionId) || taken.has(systemId)) {
        continue;
      }
      const stations = (input.stationsOf(systemId) || []).filter((s) => s && Number.isSafeInteger(s.stationId)
        && s.stationId > 0);
      if (stations.length === 0) continue;
      const station = stations.reduce((a, b) => (b.stationId < a.stationId ? b : a));
      candidates.push({ systemId, jumps, stationId: station.stationId,
        stationCorporationId: Number.isSafeInteger(station.corporationId) && station.corporationId > 0
          ? station.corporationId : null });
    }
    if (candidates.length === 0) return { ok: false, reason: "NO_BASE_CANDIDATE" };
    const c = input.rng.pick(candidates) || candidates[0];
    return { ok: true, systemId: c.systemId, stationId: c.stationId, stationCorporationId: c.stationCorporationId,
      jumps: c.jumps };
  } catch (_err) {
    return { ok: false, reason: "NO_BASE_CANDIDATE" };
  }
}

function templateOf(seed, round, templates, label = "buy") {
  const total = (templates || []).reduce((n, t) => n + t.weight, 0);
  if (!(total > 0)) return null;
  let roll = createRng(deriveSeed(seed, label, round)).nextInt(1, total);
  for (const t of templates) {
    roll -= t.weight;
    if (roll <= 0) return t;
  }
  return templates[templates.length - 1];
}

function planReview(snap, params) {
  const out = { found: null, activate: [], refuse: [], ensure: [], stipends: [], buys: [], refresh: [],
    budgetRefused: 0 };
  const sorted = [...(snap.corps || [])].sort((a, b) => a.corpSlot - b.corpSlot);
  const budget = params.fleetBudget && params.fleetBudget.enabled === true ? params.fleetBudget : null;
  let room = budget ? budgetRoomOf(snap, budget) : 0;
  const start = budget && sorted.length > 0 && Number.isSafeInteger(snap.round) && snap.round >= 0
    ? snap.round % sorted.length : 0;
  const corps = start > 0 ? [...sorted.slice(start), ...sorted.slice(0, start)] : sorted;
  if (corps.length < params.maxCorps && params.maxFoundingsPerReview > 0) {
    const used = new Set(corps.map((c) => c.corpSlot));
    for (let slot = 1; slot <= params.maxCorps; slot += 1) {
      if (!used.has(slot)) {
        out.found = { slot };
        break;
      }
    }
  }
  let buys = 0;
  for (const c of corps) {
    if (c.state === "FOUNDING") {
      const id = snap.identities instanceof Map ? snap.identities.get(c.corpSlot) : null;
      if (id && id.ok === true && id.state === "LINKED") out.activate.push({ slot: c.corpSlot, identity: id });
      else if (id && id.ok === true && id.state === "REFUSED") {
        out.refuse.push({ slot: c.corpSlot, reason: String(id.reason || "IDENTITY_REFUSED").slice(0, 64) });
      } else out.ensure.push(c.corpSlot);
      continue;
    }
    if (c.state !== "ACTIVE") continue;
    const members = Array.isArray(c.memberIds) ? c.memberIds : [];
    if (Number.isSafeInteger(params.membersPerCorp) && members.length < params.membersPerCorp) {
      const id = snap.identities instanceof Map ? snap.identities.get(c.corpSlot) : null;
      const linked = id && id.ok === true && id.state === "LINKED" && Array.isArray(id.characterIds)
        ? id.characterIds.slice(0, params.membersPerCorp) : [];
      if (linked.length > members.length && members.every((m) => linked.includes(m))) {
        out.refresh.push({ slot: c.corpSlot, memberIds: linked });
      } else out.ensure.push(c.corpSlot);
    }
    let balance = c.iskBalance;
    const stipend = Math.min(params.stipendIskPerReview, params.maxIskBalance - balance);
    if (stipend > 0) {
      out.stipends.push({ slot: c.corpSlot, amount: stipend });
      balance += stipend;
    }
    if (snap.fleetsTruncated || buys >= params.maxFleetBuysPerReview) continue;
    const fleets = (snap.fleetsByCorp instanceof Map ? snap.fleetsByCorp.get(c.corporationId) : 0) || 0;
    if (fleets >= params.maxFleetsPerCorp) continue;
    const mercs = (snap.mercByCorp instanceof Map ? snap.mercByCorp.get(c.corporationId) : 0) || 0;
    const maxMercs = Number.isSafeInteger(params.maxMercenaryFleetsPerCorp) ? params.maxMercenaryFleetsPerCorp : 0;
    let t = null;
    let fleetRole = "capsuleer";
    if (params.mercBuy === true && mercs < maxMercs) {
      t = templateOf(c.seed, snap.round, params.mercTemplates, "buy-merc");
      fleetRole = "mercenary";
    } else if (fleets - mercs < params.maxFleetsPerCorp - maxMercs) {
      t = templateOf(c.seed, snap.round, params.templates);
    }
    if (!t || balance < t.costIsk) continue;
    if (budget) {
      if (room <= 0) {
        out.budgetRefused += 1;
        buys += 1;
        continue;
      }
      room -= 1;
    }
    out.buys.push({ slot: c.corpSlot, templateId: t.templateId, costIsk: t.costIsk, fleetRole });
    buys += 1;
  }
  return out;
}

function budgetRoomOf(snap, budget) {
  const ok = (v) => Number.isSafeInteger(v) && v >= 0;
  if (!ok(snap.fleetsTotal) || !ok(snap.globalActive) || !ok(budget.maxFleetsTotal) || !ok(budget.globalLimit)
    || !ok(budget.minFleetHeadroom)) {
    return 0;
  }
  return Math.min(budget.maxFleetsTotal - snap.fleetsTotal,
    budget.globalLimit - budget.minFleetHeadroom - snap.globalActive);
}

module.exports = { corpNameOf, planBase, planReview, templateOf };
