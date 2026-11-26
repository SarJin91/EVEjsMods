"use strict";

const { affordableRuns } = require("./production");

const READY = "ready";
const ACTIVE = "ACTIVE";
const SWAP = "MINERAL_SWAP";
const NO_MINERALS_PREFIX = "PRODUCTION_NO_MINERALS:";
const PERMILLE = 1000n;
const SWAP_ROWS = 5;

const big = (n) => BigInt(Number.isSafeInteger(n) && n > 0 ? n : 0);
const count = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);
const none = () => ({ intents: [], notes: [] });

function stockOf(station, produced, recipes) {
  const stock = { ...(station.minerals || {}) };
  for (const i of (produced && produced.intents) || []) {
    if (!i || i.type !== "PRODUCE" || i.stationId !== station.stationId) continue;
    const r = recipes[i.hullGroup];
    for (const k of Object.keys((r && r.minerals) || {})) stock[k] = (stock[k] || 0) - r.minerals[k] * count(i.runs);
  }
  return stock;
}

function swapAt(stock, recipe, P, iskLeftMilli, used, stationId) {
  const prices = P.pricesMilli || {};
  const keys = Object.keys(recipe);
  if (keys.length === 0 || affordableRuns(stock, { minerals: recipe }) >= 1) return null;
  let k = null;
  let low = Infinity;
  for (const key of keys) {
    const runs = Math.floor(Math.max(0, stock[key] || 0) / recipe[key]);
    if (runs < low) {
      low = runs;
      k = key;
    }
  }
  if (k === null || !(prices[k] > 0) || used.has(`${stationId}|${k}`)) return null;
  const need = big(recipe[k] - Math.max(0, stock[k] || 0));
  if (need < 1n) return null;
  const keep = PERMILLE - BigInt(Math.min(1000, count(P.sourceKeepPermille)));
  let j = null;
  let best = -1n;
  let bestAvail = 0n;
  for (const key of Object.keys(prices).sort()) {
    if (key === k || !(prices[key] > 0)) continue;
    const have = Math.max(0, stock[key] || 0);
    if (have < count(P.minSourceUnits) || have <= 0) continue;
    const avail = (big(have - (recipe[key] || 0)) * keep) / PERMILLE;
    if (avail < 1n) continue;
    const value = avail * BigInt(prices[key]);
    if (value > best) {
      best = value;
      j = key;
      bestAvail = avail;
    }
  }
  if (j === null) return { noSource: true };
  const pk = BigInt(prices[k]);
  const pj = BigInt(prices[j]);
  const net = PERMILLE - BigInt(Math.min(999, count(P.spreadPermille)));
  const byValue = (bestAvail * pj * net) / (PERMILLE * pk);
  const byIsk = iskLeftMilli / pk;
  let take = need;
  if (byValue < take) take = byValue;
  if (byIsk < take) take = byIsk;
  if (take < 1n) return null;
  const den = pj * net;
  const give = (take * pk * PERMILLE + den - 1n) / den;
  if (give > bestAvail) return null;
  return { k, j, take, give, sourceUnits: Math.max(0, stock[j] || 0) };
}

function planMineralSwap(snapshot, produced, blocked, productionNotes, P, slotsLeft) {
  if (!P || !(slotsLeft > 0)) return none();
  const pr = snapshot && snapshot.production;
  if (!pr || pr.mode !== READY || pr.truncated === true || snapshot.stationsMode !== READY) return none();
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return none();
  const recipes = pr.recipes || {};
  const limit = Math.min(count(P.maxPerReview), slotsLeft);
  if (limit <= 0) return none();
  const stations = (pr.stations || []).filter((s) => s && typeof s.stationId === "string");
  const stocks = new Map(stations.map((s) => [s.stationId, stockOf(s, produced, recipes)]));
  const candidates = [];
  const seen = new Set();
  if (blocked && typeof blocked.hullGroup === "string") {
    candidates.push({ g: blocked.hullGroup, stationId: blocked.stationId || null });
    seen.add(blocked.hullGroup);
  }
  for (const n of productionNotes || []) {
    if (typeof n !== "string" || !n.startsWith(NO_MINERALS_PREFIX)) continue;
    const g = n.slice(NO_MINERALS_PREFIX.length);
    if (seen.has(g)) continue;
    seen.add(g);
    candidates.push({ g, stationId: null });
  }
  const intents = [];
  const notes = [];
  const used = new Set();
  let iskLeftMilli = big(P.maxIskPerReview) * PERMILLE;
  const names = P.mineralNames || {};
  const ladderStationId = produced && typeof produced.ladderStationId === "string" ? produced.ladderStationId : null;
  const offLadder = (s) => (ladderStationId !== null && s.stationId === ladderStationId ? 0 : 1);
  for (const c of candidates) {
    if (intents.length >= limit) break;
    const recipe = recipes[c.g] && recipes[c.g].minerals;
    if (!recipe || Object.keys(recipe).length === 0) continue;
    const sites = c.stationId !== null ? stations.filter((s) => s.stationId === c.stationId)
      : stations.filter((s) => count(s.lines) > 0);
    let pick = null;
    let noSource = false;
    for (const s of sites) {
      const r = swapAt(stocks.get(s.stationId), recipe, P, iskLeftMilli, used, s.stationId);
      if (!r) continue;
      if (r.noSource) {
        noSource = true;
        continue;
      }
      const off = offLadder(s);
      const pickOff = pick ? offLadder(pick.s) : 0;
      if (!pick || off > pickOff || (off === pickOff && (r.sourceUnits > pick.r.sourceUnits
        || (r.sourceUnits === pick.r.sourceUnits && s.stationId < pick.s.stationId)))) pick = { s, r };
    }
    if (!pick) {
      if (noSource) notes.push(`MINERAL_SWAP_NO_SOURCE:${c.g}`);
      continue;
    }
    const { s, r } = pick;
    const take = Number(r.take);
    const give = Number(r.give);
    if (!Number.isSafeInteger(take) || !Number.isSafeInteger(give)) continue;
    const stock = stocks.get(s.stationId);
    stock[r.j] = (stock[r.j] || 0) - give;
    stock[r.k] = (stock[r.k] || 0) + take;
    used.add(`${s.stationId}|${r.k}`);
    iskLeftMilli -= r.take * BigInt(P.pricesMilli[r.k]);
    intents.push({ type: SWAP, stationId: s.stationId, systemId: s.systemId, hullGroup: c.g,
      give: { itemKey: r.j, quantity: give }, take: { itemKey: r.k, quantity: take },
      priceVersion: P.priceVersion });
    notes.push(`MINERAL_SWAP:${names[r.k] || r.k}`);
  }
  return { intents, notes };
}

module.exports = { planMineralSwap, SWAP_ROWS };
