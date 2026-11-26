"use strict";

const { hullTargets } = require("./production");

const TRIBUTE = "TRIBUTE";
const TO_SOURCE = "TO_SOURCE";
const MINERAL = "mineral";
const MINERAL_PREFIX = "mineral/";
const PERMILLE = 1000;

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

function mineralsLeft(pr, produced, earlier, open) {
  const recipes = pr.recipes || {};
  const left = new Map(pr.stations.map((s) => [s.stationId, { ...(s.minerals || {}) }]));
  const take = (stationId, key, n) => {
    const m = left.get(stationId);
    if (m) m[key] = (m[key] || 0) - n;
  };
  for (const i of (produced && produced.intents) || []) {
    if (i.type !== "PRODUCE") continue;
    const r = recipes[i.hullGroup];
    for (const k of Object.keys((r && r.minerals) || {})) take(i.stationId, k, r.minerals[k] * i.runs);
  }
  for (const x of (produced && produced.reserve) || []) {
    if (!x || x.ladder !== true) continue;
    for (const k of Object.keys(x.minerals || {})) take(x.stationId, k, x.minerals[k]);
  }
  for (const p of earlier || []) {
    for (const it of p.items || []) if (it.itemKind === MINERAL) take(p.source.stationId, it.itemKey, it.quantity);
  }
  for (const c of open) {
    if (c.state !== TO_SOURCE) continue;
    for (const key of Object.keys(c.items || {})) {
      if (key.startsWith(MINERAL_PREFIX)) take(c.sourceStationId, key.slice(MINERAL_PREFIX.length), c.items[key]);
    }
  }
  return left;
}

function reserveOf(snapshot, pr, params, reserveRuns) {
  const recipes = pr.recipes || {};
  const reserve = {};
  for (const g of Object.keys(hullTargets(snapshot.doctrine, params.production))) {
    const r = recipes[g];
    for (const k of Object.keys((r && r.minerals) || {})) {
      reserve[k] = Math.max(reserve[k] || 0, reserveRuns * r.minerals[k]);
    }
  }
  return reserve;
}

function fitReceiver(items, station, maxStockQuantity) {
  const have = station.minerals || {};
  const out = [];
  let newRows = 0;
  for (const it of items) {
    const stock = count(have[it.itemKey]);
    const room = Number.isSafeInteger(maxStockQuantity) ? Math.max(0, maxStockQuantity - stock) : it.quantity;
    const quantity = Math.min(it.quantity, room);
    if (quantity <= 0) continue;
    if (stock === 0) newRows += 1;
    out.push({ itemKind: MINERAL, itemKey: it.itemKey, quantity });
  }
  const freeRows = Number.isSafeInteger(station.freeRows) ? station.freeRows : 0;
  return out.length > 0 && newRows <= freeRows ? out : null;
}

function planTribute(snapshot, pr, produced, earlier, params) {
  const none = (note) => ({ plan: null, notes: note ? [note] : [] });
  const P = params && params.tribute;
  const T = snapshot && snapshot.tribute;
  if (!P || !T || T.mode !== "ready" || !(P.ratePermille > 0) || !pr || !Array.isArray(pr.stations)) return none(null);
  if (T.paid === true) return none(null);
  const open = (snapshot.logistics && snapshot.logistics.open) || [];
  if (open.some((c) => c.purpose === TRIBUTE)) return none("TRIBUTE_IN_TRANSIT");
  const receivers = Array.isArray(T.recipientStations) ? [...T.recipientStations].sort((a, b) =>
    byId(a.stationId, b.stationId)) : [];
  if (T.recipientFactionId === null || T.recipientFactionId === undefined || receivers.length === 0) {
    return none("TRIBUTE_NO_RECIPIENT");
  }
  if (P.recipientMaxMineralUnits > 0 && count(T.recipientMineralUnits) >= P.recipientMaxMineralUnits) {
    return none("TRIBUTE_RECIPIENT_FULL");
  }

  const left = mineralsLeft(pr, produced, earlier, open);
  const reserve = reserveOf(snapshot, pr, params, P.reserveRuns);
  const receiverSystems = new Set(receivers.map((r) => r.systemId));
  const candidates = pr.stations.filter((s) => !receiverSystems.has(s.systemId))
    .sort((a, b) => byId(a.stationId, b.stationId));
  const surplus = new Map(candidates.map((s) => {
    const m = left.get(s.stationId) || {};
    const out = {};
    for (const k of Object.keys(m)) {
      const n = m[k] - (reserve[k] || 0);
      if (n > 0) out[k] = n;
    }
    return [s.stationId, out];
  }));
  const total = {};
  for (const m of surplus.values()) for (const k of Object.keys(m)) total[k] = (total[k] || 0) + m[k];
  const owed = {};
  for (const k of Object.keys(total)) {
    const n = Math.floor((P.ratePermille * total[k]) / PERMILLE);
    if (n > 0) owed[k] = n;
  }
  const give = (s, k) => Math.min(owed[k] || 0, surplus.get(s.stationId)[k] || 0);
  let source = null;
  let best = 0;
  for (const s of candidates) {
    const score = Object.keys(owed).reduce((n, k) => n + give(s, k), 0);
    if (score > best) {
      source = s;
      best = score;
    }
  }
  if (!source) return none("TRIBUTE_NO_SURPLUS");
  const items = Object.keys(owed).sort().filter((k) => give(source, k) > 0)
    .map((k) => ({ itemKind: MINERAL, itemKey: k, quantity: give(source, k) }));
  for (const r of receivers) {
    if (r.systemId === source.systemId) continue;
    const fitted = fitReceiver(items, r, T.maxStockQuantity);
    if (!fitted) continue;
    return { plan: { purpose: TRIBUTE, source, dest: { stationId: r.stationId, systemId: r.systemId },
      items: fitted, noMobilize: true, minLoad: P.minLoadVolume, tributeBucket: T.bucket }, notes: [] };
  }
  return none("TRIBUTE_RECIPIENT_FULL");
}

module.exports = { planTribute };
