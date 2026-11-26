"use strict";

const { MINERAL_TYPE_IDS, MINERAL_VOLUME, HULL_VOLUMES, CARRIER_GROUPS, VOLUME_UNITS_PER_M3 } =
  require("../data/cargoVolumes");

const KIND_MINERAL = "mineral";
const KIND_HULL = "hull";
const MINERAL_RE = /^type:(\d+)$/;
const GROUP_RE = /^group:([a-z_]{1,32})$/;

const big = (v) => BigInt(Math.max(0, Math.trunc(Number(v) || 0)));
const isQty = (v) => Number.isSafeInteger(v) && v > 0;

function unitVolume(kindKey) {
  if (typeof kindKey !== "string") return null;
  const slash = kindKey.indexOf("/");
  if (slash < 1) return null;
  const kind = kindKey.slice(0, slash);
  const key = kindKey.slice(slash + 1);
  if (kind === KIND_MINERAL) {
    const m = MINERAL_RE.exec(key);
    return m && MINERAL_TYPE_IDS.includes(Number(m[1])) ? MINERAL_VOLUME : null;
  }
  if (kind === KIND_HULL) {
    const m = GROUP_RE.exec(key);
    if (!m || !Object.prototype.hasOwnProperty.call(HULL_VOLUMES, m[1])) return null;
    const v = HULL_VOLUMES[m[1]];
    return Number.isSafeInteger(v) && v > 0 ? v : null;
  }
  return null;
}

function cargoVolume(cargo) {
  if (!cargo || typeof cargo !== "object" || Array.isArray(cargo)) {
    return { ok: false, reason: "CARGO_INVALID", detail: "cargo" };
  }
  let volume = 0n;
  for (const k of Object.keys(cargo).sort()) {
    const v = unitVolume(k);
    if (v === null) return { ok: false, reason: "CARGO_INVALID", detail: k };
    if (!isQty(cargo[k])) return { ok: false, reason: "CARGO_INVALID", detail: `${k}=${cargo[k]}` };
    volume += BigInt(v) * BigInt(cargo[k]);
  }
  if (volume > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "CARGO_INVALID", detail: "volume" };
  return { ok: true, volume: Number(volume) };
}

function carriersOf(composition) {
  let n = 0;
  for (const e of Array.isArray(composition) ? composition : []) {
    if (e && CARRIER_GROUPS.includes(e.hullGroup) && Number.isSafeInteger(e.count) && e.count > 0) n += e.count;
  }
  return n;
}

const PERMILLE = 1000;
const nonNegative = (v) => Math.max(0, Math.trunc(Number(v) || 0));

function carrierCapacitiesM3(L, catalog) {
  const out = {};
  for (const g of CARRIER_GROUPS) {
    if (g === "industrial") {
      out[g] = nonNegative(L && L.carrierCapacityM3);
      continue;
    }
    let row = null;
    try {
      row = catalog && typeof catalog.hull === "function" ? catalog.hull(g) : null;
    } catch (_err) {
      row = null;
    }
    const median = row ? nonNegative(row.cargoMedianM3) : 0;
    out[g] = Math.floor((median * nonNegative(L && L.capitalCargoPermille)) / PERMILLE);
  }
  return Object.freeze(out);
}

function capacityOf(composition, params) {
  const map = params && params.capacityM3 && typeof params.capacityM3 === "object" ? params.capacityM3 : null;
  const capOf = (g) => (map ? nonNegative(map[g]) : g === "industrial" ? nonNegative(params.carrierCapacityM3) : 0);
  let units = 0;
  for (const e of Array.isArray(composition) ? composition : []) {
    if (e && CARRIER_GROUPS.includes(e.hullGroup) && Number.isSafeInteger(e.count) && e.count > 0) {
      units += e.count * capOf(e.hullGroup) * VOLUME_UNITS_PER_M3;
    }
  }
  return units;
}

function scaleCargo(cargo, carriersAtLoad, carriersNow) {
  const atLoad = Math.max(1, Math.trunc(Number(carriersAtLoad) || 1));
  const now = Math.min(atLoad, Math.max(0, Math.trunc(Number(carriersNow) || 0)));
  const deliver = {};
  let lost = 0n;
  for (const key of Object.keys(cargo || {}).sort()) {
    const have = big(cargo[key]);
    const part = (have * BigInt(now)) / BigInt(atLoad);
    lost += have - part;
    if (part > 0n) deliver[key] = Number(part);
  }
  return { deliver, lostUnits: Number(lost) };
}

function fitCargo(cargo, capacity) {
  let room = Math.max(0, Math.trunc(Number(capacity) || 0));
  const out = {};
  for (const key of Object.keys(cargo || {}).sort()) {
    const v = unitVolume(key);
    if (v === null || !isQty(cargo[key])) continue;
    const n = Math.min(cargo[key], Math.floor(room / v));
    if (n > 0) {
      out[key] = n;
      room -= n * v;
    }
  }
  return out;
}

function cargoUnits(cargo) {
  let n = 0;
  for (const key of Object.keys(cargo || {})) n += Math.max(0, Number(cargo[key]) || 0);
  return n;
}

function toDeltas(cargo, sign) {
  return Object.keys(cargo || {}).sort().filter((k) => cargo[k] > 0).map((k) => {
    const slash = k.indexOf("/");
    return { itemKind: k.slice(0, slash), itemKey: k.slice(slash + 1), delta: sign * cargo[k] };
  });
}

function itemsToCargo(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const out = {};
  for (const it of items) {
    if (!it || (it.itemKind !== KIND_MINERAL && it.itemKind !== KIND_HULL) || typeof it.itemKey !== "string"
      || !isQty(it.quantity)) return null;
    const k = `${it.itemKind}/${it.itemKey}`;
    if (Object.prototype.hasOwnProperty.call(out, k)) return null;
    out[k] = it.quantity;
  }
  return out;
}

module.exports = { cargoVolume, carriersOf, capacityOf, carrierCapacitiesM3, scaleCargo, fitCargo, cargoUnits, toDeltas, itemsToCargo,
  unitVolume, KIND_MINERAL, KIND_HULL };
