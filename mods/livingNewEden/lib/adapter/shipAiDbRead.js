"use strict";

const { sessionOf } = require("./shipTelemetry");

const REASONS = Object.freeze({ NO_SESSION: "NO_SESSION", NO_SHIP: "NO_SHIP", NO_RECORD: "NO_RECORD",
  SEAM: "SEAM_UNAVAILABLE" });
const MAX_NAME_CHARS = 100;
const VOLUME_DECIMALS = 100;
const HOLDS = Object.freeze([["cargo", "CARGO_HOLD"], ["drones", "DRONE_BAY"], ["fleet", "FLEET_HANGAR"]]);
const RACKS = Object.freeze([["high", 27, 34], ["med", 19, 26], ["low", 11, 18], ["rig", 92, 99],
  ["subsystem", 125, 132]]);

const isObj = (v) => Boolean(v) && typeof v === "object";
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const fn = (mod, name) => (isObj(mod) && typeof mod[name] === "function" ? mod[name] : null);
const fail = (reason) => ({ ok: false, reason });
const intOf = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isSafeInteger(n) ? n : 0;
};
const unitsOf = (row) => (intOf(row.singleton) > 0 ? 1 : Math.max(0, intOf(row.stacksize ?? row.quantity)));
const rowsMax = (opts) => (opts && Number.isSafeInteger(opts.maxRows) && opts.maxRows > 0 ? opts.maxRows : 1);

function shipOf(m, playerId) {
  if (!isId(playerId)) return fail(REASONS.NO_SESSION);
  const found = sessionOf(m.sessionRegistry, playerId);
  if (!found.ok) return found;
  const s = found.session;
  const docked = Boolean(s.stationid || s.stationID || s.structureid || s.structureID);
  const space = !docked && isObj(s._space) ? s._space : null;
  const shipId = intOf((space && space.shipID) || s.shipID || s.shipid);
  if (!isId(shipId)) return fail(REASONS.NO_SHIP);
  const find = fn(m.itemStore, "findItemById");
  if (!find) return fail(REASONS.SEAM);
  const ship = find.call(m.itemStore, shipId);
  if (!isObj(ship) || intOf(ship.ownerID) !== playerId) return fail(REASONS.NO_SHIP);
  const typeId = intOf(ship.typeID);
  return { ok: true, shipId, shipTypeId: isId(typeId) ? typeId : null, docked };
}

function ownRows(itemStore, playerId, locationId, flag) {
  const list = fn(itemStore, "listContainerItems");
  if (!list) return null;
  const rows = list.call(itemStore, playerId, locationId, flag);
  if (!Array.isArray(rows)) return null;
  return rows.filter((r) => isObj(r) && intOf(r.ownerID) === playerId && intOf(r.locationID) === locationId);
}

function readCargoFrom(mods, playerId, opts) {
  try {
    const m = mods || {};
    const flags = isObj(m.itemStore) && isObj(m.itemStore.ITEM_FLAGS) ? m.itemStore.ITEM_FLAGS : null;
    if (!flags || !fn(m.itemStore, "listContainerItems")) return fail(REASONS.SEAM);
    const ship = shipOf(m, playerId);
    if (!ship.ok) return ship;
    const max = rowsMax(opts);
    const holds = [];
    let volume = 0;
    for (const [hold, key] of HOLDS) {
      const flag = intOf(flags[key]);
      if (!isId(flag)) return fail(REASONS.SEAM);
      const rows = ownRows(m.itemStore, playerId, ship.shipId, flag);
      if (rows === null) return fail(REASONS.SEAM);
      const byType = new Map();
      for (const r of rows) {
        const typeId = intOf(r.typeID);
        if (!isId(typeId)) continue;
        const qty = unitsOf(r);
        byType.set(typeId, (byType.get(typeId) || 0) + qty);
        if (hold === "cargo" && volume !== null) {
          const v = Number(r.volume);
          volume = Number.isFinite(v) && v >= 0 ? volume + v * qty : null;
        }
      }
      const items = [...byType].map(([typeId, qty]) => ({ typeId, qty }))
        .sort((a, b) => b.qty - a.qty || a.typeId - b.typeId);
      if (hold === "cargo" || items.length > 0) {
        holds.push({ hold, items: items.slice(0, max), more: Math.max(0, items.length - max) });
      }
    }
    return { ok: true, docked: ship.docked, shipTypeId: ship.shipTypeId, holds,
      volumeM3: volume === null ? null : Math.round(volume * VOLUME_DECIMALS) / VOLUME_DECIMALS };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

const rackOf = (flag) => {
  const hit = RACKS.find(([, lo, hi]) => flag >= lo && flag <= hi);
  return hit ? hit[0] : null;
};

function readFittingFrom(mods, playerId, opts) {
  try {
    const m = mods || {};
    const isFlag = fn(m.liveFitting, "isShipFittingFlag");
    const isCharge = fn(m.liveFitting, "isChargeItem");
    const isModule = fn(m.liveFitting, "isFittedModuleItem");
    if (!isFlag || !isCharge || !isModule || !fn(m.itemStore, "listContainerItems")) return fail(REASONS.SEAM);
    const ship = shipOf(m, playerId);
    if (!ship.ok) return ship;
    const rows = ownRows(m.itemStore, playerId, ship.shipId, null);
    if (rows === null) return fail(REASONS.SEAM);
    const slots = new Map();
    for (const r of rows) {
      const flag = intOf(r.flagID);
      const typeId = intOf(r.typeID);
      if (!isId(typeId) || isFlag.call(m.liveFitting, flag) !== true || rackOf(flag) === null) continue;
      const slot = slots.get(flag) || { module: null, charge: null, chargeQty: 0 };
      if (isModule.call(m.liveFitting, r) === true) slot.module = typeId;
      else if (isCharge.call(m.liveFitting, r)) {
        slot.charge = typeId;
        slot.chargeQty += unitsOf(r);
      }
      slots.set(flag, slot);
    }
    const max = rowsMax(opts);
    const racks = [];
    for (const [rack] of RACKS) {
      const groups = new Map();
      for (const [flag, slot] of [...slots].sort((a, b) => a[0] - b[0])) {
        if (rackOf(flag) !== rack || slot.module === null) continue;
        const key = `${slot.module}|${slot.charge || 0}`;
        const g = groups.get(key) || { typeId: slot.module, count: 0, chargeTypeId: slot.charge, chargeQty: 0 };
        g.count += 1;
        g.chargeQty += slot.chargeQty;
        groups.set(key, g);
      }
      const modules = [...groups.values()];
      if (modules.length > 0) {
        racks.push({ rack, modules: modules.slice(0, max), more: Math.max(0, modules.length - max) });
      }
    }
    return { ok: true, shipTypeId: ship.shipTypeId, racks };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

function readPilotFrom(mods, playerId) {
  try {
    const m = mods || {};
    const peek = fn(m.characterState, "peekCharacterRecord");
    if (!peek) return fail(REASONS.SEAM);
    if (!isId(playerId)) return fail(REASONS.NO_RECORD);
    const rec = peek.call(m.characterState, playerId);
    if (!isObj(rec)) return fail(REASONS.NO_RECORD);
    const sec = Number(rec.securityStatus ?? rec.securityRating);
    const home = intOf(rec.homeStationID || rec.cloneStationID);
    const created = rec.createDateTime;
    const corpId = intOf(rec.corporationID);
    return { ok: true, corporationName: corporationNameOf(m.corporationState, corpId),
      securityStatus: Number.isFinite(sec) ? sec : null, homeStationId: isId(home) ? home : null,
      createdFileTime: (typeof created === "string" || typeof created === "number" || typeof created === "bigint")
        && /^\d{1,20}$/.test(String(created)) ? String(created) : null };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

function corporationNameOf(corporationState, corpId) {
  const lookup = fn(corporationState, "getOwnerLookupRecord");
  if (!lookup || !isId(corpId)) return null;
  try {
    const owner = lookup.call(corporationState, corpId);
    return isObj(owner) && typeof owner.ownerName === "string" && owner.ownerName !== ""
      ? owner.ownerName.slice(0, MAX_NAME_CHARS) : null;
  } catch (_err) {
    return null;
  }
}

const LOCATION_RANGES = Object.freeze({ stationMin: 60000000, stationMax: 64000000, structureMin: 1e12,
  structureMax: 1040000000000, systemMin: 30000000, systemMax: 33000000 });
const JOURNAL_MAX_ENTRIES = 100;
const SHIP_CATEGORY = 6;
const FILETIME_PER_MS = 10000n;
const FILETIME_EPOCH_MS = 11644473600000n;

function siteKindOf(locationId) {
  const L = LOCATION_RANGES;
  if (locationId >= L.stationMin && locationId < L.stationMax) return "station";
  if (locationId > L.structureMin && locationId < L.structureMax) return "structure";
  if (locationId >= L.systemMin && locationId < L.systemMax) return "space";
  return null;
}

function ownedRows(itemStore, playerId, opts) {
  const list = fn(itemStore, "listOwnedItems");
  if (!list || !isId(playerId)) return null;
  const rows = list.call(itemStore, playerId, opts);
  if (!Array.isArray(rows)) return null;
  return rows.filter((r) => isObj(r) && intOf(r.ownerID) === playerId && isId(intOf(r.locationID)));
}

function readAssetsFrom(mods, playerId, opts) {
  try {
    const m = mods || {};
    const rows = ownedRows(m.itemStore, playerId, {});
    if (rows === null) return fail(REASONS.SEAM);
    const own = new Set(rows.map((r) => intOf(r.itemID)));
    const by = new Map();
    let total = 0;
    for (const r of rows) {
      const loc = intOf(r.locationID);
      const kind = siteKindOf(loc);
      if (own.has(loc) || (kind !== "station" && kind !== "structure")) continue;
      const g = by.get(loc) || { locationId: loc, kind, items: 0, ships: 0 };
      if (intOf(r.categoryID) === SHIP_CATEGORY) g.ships += 1;
      else {
        g.items += 1;
        total += 1;
      }
      by.set(loc, g);
    }
    const locations = [...by.values()]
      .sort((a, b) => (b.items + b.ships) - (a.items + a.ships) || a.locationId - b.locationId);
    const max = rowsMax(opts);
    return { ok: true, locations: locations.slice(0, max), totalItems: total,
      more: Math.max(0, locations.length - max) };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

function readFindItemFrom(mods, playerId, typeId, opts) {
  try {
    const m = mods || {};
    const find = fn(m.itemStore, "findItemById");
    if (!find || !isId(typeId)) return fail(REASONS.SEAM);
    const rows = ownedRows(m.itemStore, playerId, { typeID: typeId });
    if (rows === null) return fail(REASONS.SEAM);
    const by = new Map();
    let total = 0;
    for (const r of rows) {
      if (intOf(r.typeID) !== typeId) continue;
      const loc = intOf(r.locationID);
      let place = by.get(loc);
      if (!place) {
        place = placeOf(m.itemStore, find, playerId, loc);
        if (place === null) continue;
        by.set(loc, place);
      }
      const qty = unitsOf(r);
      place.qty += qty;
      total += qty;
    }
    const places = [...by.values()].sort((a, b) => b.qty - a.qty || a.locationId - b.locationId);
    const max = rowsMax(opts);
    return { ok: true, places: places.slice(0, max), totalQty: total, more: Math.max(0, places.length - max) };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

function placeOf(itemStore, find, playerId, loc) {
  const kind = siteKindOf(loc);
  if (kind !== null) return { locationId: loc, kind, qty: 0, holderTypeId: null, siteId: loc, siteKind: kind };
  const holder = find.call(itemStore, loc);
  if (!isObj(holder) || intOf(holder.ownerID) !== playerId) return null;
  const holderType = intOf(holder.typeID);
  const site = intOf(holder.locationID);
  const siteKind = siteKindOf(site);
  return { locationId: loc, kind: intOf(holder.categoryID) === SHIP_CATEGORY ? "ship" : "container", qty: 0,
    holderTypeId: isId(holderType) ? holderType : null, siteId: siteKind === null ? null : site, siteKind };
}

function msOfFileTime(value) {
  const text = typeof value === "bigint" || typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d{1,20}$/.test(text)) return null;
  const ms = Number(BigInt(text) / FILETIME_PER_MS - FILETIME_EPOCH_MS);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

function journalTypeNames(types) {
  const out = new Map();
  for (const [key, value] of Object.entries(types)) {
    const v = Number(value);
    if (Number.isSafeInteger(v) && !out.has(v)) out.set(v, key.toLowerCase());
  }
  return out;
}

function readWalletHistoryFrom(mods, playerId, opts) {
  try {
    const m = mods || {};
    const projection = fn(m.walletProjection, "getCharacterProjection");
    const peek = fn(m.characterState, "peekCharacterRecord");
    const ws = isObj(m.walletState) ? m.walletState : null;
    const types = ws && isObj(ws.JOURNAL_ENTRY_TYPE) ? ws.JOURNAL_ENTRY_TYPE : null;
    const cash = ws && isObj(ws.ACCOUNT_KEY) ? intOf(ws.ACCOUNT_KEY.CASH) : 0;
    if (!projection || !peek || !types || !isId(cash)) return fail(REASONS.SEAM);
    if (!isId(playerId)) return fail(REASONS.NO_RECORD);
    const projected = projection.call(m.walletProjection, playerId);
    let journal;
    if (isObj(projected)) {
      if (projected.characterID !== undefined && intOf(projected.characterID) !== playerId) {
        return fail(REASONS.NO_RECORD);
      }
      journal = projected.walletJournal;
    } else {
      const rec = peek.call(m.characterState, playerId);
      if (!isObj(rec)) return fail(REASONS.NO_RECORD);
      journal = rec.walletJournal;
    }
    const names = journalTypeNames(types);
    const nowMs = Number(opts && opts.nowMs);
    const windowMs = Number(opts && opts.sumWindowMs);
    const since = Number.isFinite(nowMs) && Number.isFinite(windowMs) ? nowMs - windowMs : null;
    const rows = [];
    let inIsk = 0;
    let outIsk = 0;
    const all = Array.isArray(journal) ? journal : [];
    let oldestMs = null;
    for (const e of all) {
      const anyMs = isObj(e) ? msOfFileTime(e.transactionDate) : null;
      if (anyMs !== null && (oldestMs === null || anyMs < oldestMs)) oldestMs = anyMs;
      if (!isObj(e) || intOf(e.accountKey) !== cash) continue;
      const amount = Number(e.amount);
      if (!Number.isFinite(amount)) continue;
      const atMs = msOfFileTime(e.transactionDate);
      if (since !== null && atMs !== null && atMs >= since) {
        if (amount > 0) inIsk += amount;
        else outIsk -= amount;
      }
      const balance = Number(e.balance);
      rows.push({ atMs, type: names.get(intOf(e.entryTypeID)) || "other", amountIsk: amount,
        balanceIsk: Number.isFinite(balance) ? balance : null });
    }
    rows.sort((a, b) => (b.atMs ?? -1) - (a.atMs ?? -1));
    const max = rowsMax(opts);
    const entries = rows.slice(0, max).map((r) => ({
      whenMsAgo: r.atMs !== null && Number.isFinite(nowMs) ? Math.max(0, nowMs - r.atMs) : null,
      type: r.type, amountIsk: r.amountIsk, balanceIsk: r.balanceIsk }));
    const truncated = all.length >= JOURNAL_MAX_ENTRIES && since !== null && oldestMs !== null && oldestMs >= since;
    return { ok: true, entries, window: { inIsk, outIsk, truncated }, more: Math.max(0, rows.length - max) };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

const INCOME_SOURCES = Object.freeze({ NPC_BOUNTY_PRIZE: "bounty", NPC_BOUNTY_PRIZES: "bounty", INSURANCE: "insurance",
  AGENT_MISSION_REWARD: "mission", AGENT_MISSION_TIME_BONUS_REWARD: "mission", PLAYER_DONATION: "donation" });

function readWalletIncomeFrom(mods, playerId) {
  try {
    const m = mods || {};
    const projection = fn(m.walletProjection, "getCharacterProjection");
    const peek = fn(m.characterState, "peekCharacterRecord");
    const ws = isObj(m.walletState) ? m.walletState : null;
    const types = ws && isObj(ws.JOURNAL_ENTRY_TYPE) ? ws.JOURNAL_ENTRY_TYPE : null;
    const cash = ws && isObj(ws.ACCOUNT_KEY) ? intOf(ws.ACCOUNT_KEY.CASH) : 0;
    if (!projection || !peek || !types || !isId(cash)) return fail(REASONS.SEAM);
    if (!isId(playerId)) return fail(REASONS.NO_RECORD);
    const projected = projection.call(m.walletProjection, playerId);
    let journal;
    if (isObj(projected)) {
      if (projected.characterID !== undefined && intOf(projected.characterID) !== playerId) {
        return fail(REASONS.NO_RECORD);
      }
      journal = projected.walletJournal;
    } else {
      const rec = peek.call(m.characterState, playerId);
      if (!isObj(rec)) return fail(REASONS.NO_RECORD);
      journal = rec.walletJournal;
    }
    const sourceOf = new Map();
    for (const [name, source] of Object.entries(INCOME_SOURCES)) {
      const v = Number(types[name]);
      if (Number.isSafeInteger(v) && !sourceOf.has(v)) sourceOf.set(v, source);
    }
    const entries = [];
    for (const e of Array.isArray(journal) ? journal : []) {
      if (!isObj(e) || intOf(e.accountKey) !== cash) continue;
      const source = sourceOf.get(intOf(e.entryTypeID));
      const amount = Number(e.amount);
      const id = Number(e.transactionID);
      const atMs = msOfFileTime(e.transactionDate);
      if (!source || !Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(id) || atMs === null) continue;
      entries.push({ transactionId: id, source, amountIsk: amount, atMs, own: intOf(e.ownerID2) === playerId });
    }
    entries.sort((a, b) => b.atMs - a.atMs || b.transactionId - a.transactionId);
    return { ok: true, entries };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

function readSkillQueueFrom(mods, playerId, opts) {
  try {
    const m = mods || {};
    const read = fn(m.skillQueueState, "getCharacterQueueState");
    if (!read) return fail(REASONS.SEAM);
    if (!isId(playerId)) return fail(REASONS.NO_RECORD);
    const state = read.call(m.skillQueueState, playerId);
    if (!isObj(state)) return fail(REASONS.SEAM);
    const queue = (Array.isArray(state.queue) ? state.queue : [])
      .filter((e) => isObj(e) && isId(intOf(e.typeID)) && intOf(e.toLevel) > 0)
      .map((e) => ({ typeId: intOf(e.typeID), toLevel: intOf(e.toLevel) }));
    const max = rowsMax(opts);
    return { ok: true, active: state.active === true, queue: queue.slice(0, max),
      more: Math.max(0, queue.length - max) };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

const SKILL_DONE_EVENTS = Object.freeze([37, 53]);

function readSkillHistoryFrom(mods, playerId, opts) {
  try {
    const m = mods || {};
    const peek = fn(m.characterState, "peekCharacterRecord");
    if (!peek) return fail(REASONS.SEAM);
    if (!isId(playerId)) return fail(REASONS.NO_RECORD);
    const rec = peek.call(m.characterState, playerId);
    if (!isObj(rec)) return fail(REASONS.NO_RECORD);
    const since = opts && Number.isFinite(opts.sinceMs) ? opts.sinceMs : 0;
    const max = opts && Number.isSafeInteger(opts.max) && opts.max > 0 ? opts.max : 1;
    const entries = [];
    for (const e of Array.isArray(rec.skillHistory) ? rec.skillHistory : []) {
      if (!isObj(e) || !SKILL_DONE_EVENTS.includes(intOf(e.eventTypeID))) continue;
      const typeId = intOf(e.skillTypeID);
      const atMs = msOfFileTime(e.logDate);
      if (!isId(typeId) || atMs === null || atMs < since) continue;
      entries.push({ typeId, atMs });
    }
    entries.sort((a, b) => b.atMs - a.atMs || a.typeId - b.typeId);
    return { ok: true, entries: entries.slice(0, max) };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

function readStandingsFrom(mods, playerId, opts) {
  try {
    const m = mods || {};
    const peek = fn(m.characterState, "peekCharacterRecord");
    const isNpc = opts && typeof opts.isNpcOwnerId === "function" ? opts.isNpcOwnerId : null;
    if (!peek || !isNpc) return fail(REASONS.SEAM);
    if (!isId(playerId)) return fail(REASONS.NO_RECORD);
    const rec = peek.call(m.characterState, playerId);
    if (!isObj(rec)) return fail(REASONS.NO_RECORD);
    const data = isObj(rec.standingData) ? rec.standingData : {};
    const byOwner = new Map();
    for (const bucket of ["char", "npc"]) {
      for (const r of Array.isArray(data[bucket]) ? data[bucket] : []) {
        if (!isObj(r) || intOf(r.toID) !== playerId) continue;
        const from = intOf(r.fromID);
        const standing = Number(r.standing);
        if (!isId(from) || from === playerId || byOwner.has(from) || !Number.isFinite(standing)) continue;
        if (isNpc(from) !== true) continue;
        byOwner.set(from, standing);
      }
    }
    const half = Math.max(1, Math.floor(rowsMax(opts) / 2));
    const all = [...byOwner].map(([ownerId, standing]) => ({ ownerId, standing }));
    const named = (list) => list.slice(0, half)
      .map((r) => ({ ...r, name: corporationNameOf(m.corporationState, r.ownerId) }));
    return { ok: true,
      top: named(all.filter((r) => r.standing > 0).sort((a, b) => b.standing - a.standing || a.ownerId - b.ownerId)),
      bottom: named(all.filter((r) => r.standing < 0).sort((a, b) => a.standing - b.standing || a.ownerId - b.ownerId)) };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

const NOT_CACHED = "NOT_CACHED";
const TIMEOUT = "TIMEOUT";
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const HOURS_DECIMALS = 10;
const MAX_TITLE_CHARS = 100;
const MAX_LABEL_CHARS = 40;
const JOB_STATUS = Object.freeze({ PAUSED: 2, READY: 3 });
const idOrNull = (v) => {
  const n = intOf(v);
  return isId(n) ? n : null;
};
const textOrNull = (v, max) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);

function readKillmailsFrom(mods, playerId, opts) {
  try {
    const m = mods || {};
    const stats = fn(m.killmailState, "getKillmailProjectionStats");
    const list = fn(m.killmailState, "listKillmailsForCharacter");
    if (!stats || !list || !isId(playerId)) return fail(REASONS.SEAM);
    const s = stats.call(m.killmailState);
    if (!isObj(s) || s.ready !== true || s.dirty !== false) return fail(NOT_CACHED);
    const max = rowsMax(opts);
    const rows = list.call(m.killmailState, playerId, { limit: max + 1 });
    if (!Array.isArray(rows)) return fail(REASONS.SEAM);
    const nowMs = Number(opts && opts.nowMs);
    const entries = [];
    for (const r of rows) {
      if (!isObj(r)) continue;
      const attackers = Array.isArray(r.attackers) ? r.attackers.filter(isObj) : [];
      const own = attackers.find((a) => intOf(a.characterID) === playerId) || null;
      const loss = intOf(r.victimCharacterID) === playerId;
      const final = intOf(r.finalCharacterID) === playerId;
      if (!loss && !final && !own) continue;
      const atMs = msOfFileTime(r.killTime);
      const isk = Number(r.iskLost);
      entries.push({ role: loss ? "loss" : "kill",
        whenMsAgo: atMs !== null && Number.isFinite(nowMs) ? Math.max(0, nowMs - atMs) : null,
        systemId: idOrNull(r.solarSystemID), victimShipTypeId: idOrNull(r.victimShipTypeID),
        ownShipTypeId: loss ? idOrNull(r.victimShipTypeID) : idOrNull(final ? r.finalShipTypeID : own.shipTypeID),
        attackers: Math.max(attackers.length, isId(intOf(r.finalCharacterID)) ? 1 : 0),
        iskLost: r.iskLost !== null && r.iskLost !== undefined && Number.isFinite(isk) ? isk : null });
    }
    return { ok: true, entries: entries.slice(0, max), more: Math.max(0, entries.length - max) };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

function readMissionsFrom(mods, playerId, opts) {
  try {
    const m = mods || {};
    const read = fn(m.gameStore, "read");
    if (!read || !isId(playerId)) return fail(REASONS.SEAM);
    const res = read.call(m.gameStore, "missionRuntimeState", `/charactersByID/${playerId}`);
    if (!isObj(res)) return fail(REASONS.SEAM);
    if (res.success !== true) {
      return res.errorMsg === "ENTRY_NOT_FOUND" ? { ok: true, missions: [], more: 0 } : fail(REASONS.SEAM);
    }
    const rec = res.data;
    if (!isObj(rec) || (rec.characterID !== undefined && intOf(rec.characterID) !== playerId)) {
      return { ok: true, missions: [], more: 0 };
    }
    const byAgent = isObj(rec.missionsByAgentID) ? rec.missionsByAgentID : {};
    const nowMs = Number(opts && opts.nowMs);
    const list = [];
    for (const key of Object.keys(byAgent)) {
      const x = byAgent[key];
      if (!isObj(x)) continue;
      const expMs = msOfFileTime(x.expiresAtFileTime);
      list.push({ seq: intOf(x.missionSequence), mission: { title: textOrNull(x.missionTitle, MAX_TITLE_CHARS),
        kind: textOrNull(x.missionKind, MAX_LABEL_CHARS), status: textOrNull(x.runtimeStatus, MAX_LABEL_CHARS),
        done: x.objectiveCompleted === true, systemId: idOrNull(x.missionSystemID),
        expiresInHours: expMs !== null && Number.isFinite(nowMs)
          ? Math.round(Math.max(0, expMs - nowMs) / MS_PER_HOUR * HOURS_DECIMALS) / HOURS_DECIMALS : null,
        agentId: idOrNull(key), expiresAtMs: expMs } });
    }
    list.sort((a, b) => a.seq - b.seq);
    const max = rowsMax(opts);
    return { ok: true, missions: list.slice(0, max).map((x) => x.mission), more: Math.max(0, list.length - max) };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

function readIndustryJobsFrom(mods, playerId, opts) {
  try {
    const m = mods || {};
    const list = fn(m.industry, "listJobsByOwner");
    if (!list || !isId(playerId)) return fail(REASONS.SEAM);
    const rows = list.call(m.industry, playerId, false);
    if (!Array.isArray(rows)) return fail(REASONS.SEAM);
    const nowMs = Number(opts && opts.nowMs);
    const jobs = [];
    for (const j of rows) {
      if (!isObj(j) || intOf(j.ownerID) !== playerId) continue;
      const endMs = msOfFileTime(j.endDate);
      const status = intOf(j.status);
      const known = endMs !== null && Number.isFinite(nowMs);
      jobs.push({ endMs, job: { activityId: intOf(j.activityID), productTypeId: idOrNull(j.productTypeID),
        runs: Math.max(0, intOf(j.runs)),
        endsInMinutes: known ? Math.round(Math.max(0, endMs - nowMs) / MS_PER_MINUTE) : null,
        ready: status === JOB_STATUS.READY || (status !== JOB_STATUS.PAUSED && known && endMs <= nowMs),
        jobId: idOrNull(j.jobID), endAtMs: endMs } });
    }
    jobs.sort((a, b) => (a.endMs ?? Number.MAX_SAFE_INTEGER) - (b.endMs ?? Number.MAX_SAFE_INTEGER));
    const max = rowsMax(opts);
    return { ok: true, jobs: jobs.slice(0, max).map((x) => x.job), more: Math.max(0, jobs.length - max) };
  } catch (_err) {
    return fail(REASONS.SEAM);
  }
}

const signalTimeout = (cb, ms) => AbortSignal.timeout(ms).addEventListener("abort", cb, { once: true });

const ORDER_FINAL_STATES = Object.freeze(["filled", "expired", "cancelled"]);
const ORDER_OPEN = "open";
const stateOf = (o) => String(o.state || ORDER_OPEN).toLowerCase();
const msOfIso = (v) => {
  const ms = typeof v === "string" && v !== "" ? Date.parse(v) : Number.NaN;
  return Number.isSafeInteger(ms) ? ms : null;
};

function ordersOf(result, playerId, max, includeClosed) {
  if (!Array.isArray(result)) return fail(REASONS.SEAM);
  const orders = [];
  const closed = [];
  for (const o of result) {
    if (!isObj(o) || o.is_corp === true) continue;
    if (o.owner_id !== undefined && intOf(o.owner_id) !== playerId) continue;
    const state = stateOf(o);
    const row = isObj(o.row) ? o.row : o;
    const typeId = intOf(row.type_id);
    if (state !== ORDER_OPEN) {
      const orderId = idOrNull(row.order_id ?? o.order_id);
      if (includeClosed && ORDER_FINAL_STATES.includes(state) && o.owner_id !== undefined && orderId !== null
        && isId(typeId)) {
        closed.push({ orderId, side: row.bid ? "buy" : "sell", typeId, total: Math.max(0, intOf(row.vol_entered)),
          state, changedAtMs: msOfIso(o.last_state_change_at) });
      }
      continue;
    }
    const price = Number(row.price);
    if (!isId(typeId) || !Number.isFinite(price)) continue;
    orders.push({ side: row.bid ? "buy" : "sell", typeId, priceIsk: price,
      remaining: Math.max(0, intOf(row.vol_remaining)), total: Math.max(0, intOf(row.vol_entered)),
      stationId: idOrNull(row.station_id), orderId: idOrNull(row.order_id ?? o.order_id) });
  }
  orders.sort((a, b) => b.priceIsk * b.remaining - a.priceIsk * a.remaining || a.typeId - b.typeId);
  const out = { ok: true, orders: orders.slice(0, max), more: Math.max(0, orders.length - max) };
  if (includeClosed) out.closed = closed;
  return out;
}

function readMarketOrdersFrom(mods, playerId, opts) {
  return daemonRead(mods, playerId, opts, "GetCharOrders", { owner_id: playerId, is_corp: false },
    (result) => ordersOf(result, playerId, rowsMax(opts), Boolean(opts && opts.includeClosed === true)));
}

function daemonRead(mods, playerId, opts, method, params, onResult, onError) {
  try {
    const m = mods || {};
    const daemonCall = fn(m.marketDaemon, "call");
    const timeoutMs = Number(opts && opts.timeoutMs);
    if (!daemonCall || !isId(playerId) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.resolve(fail(REASONS.SEAM));
    }
    const timer = opts && typeof opts.setTimeoutFn === "function" ? opts.setTimeoutFn : signalTimeout;
    const answer = Promise.resolve()
      .then(() => daemonCall.call(m.marketDaemon, method, params))
      .then(onResult, (err) => (onError ? onError(err) : fail(REASONS.SEAM)));
    const late = new Promise((resolve) => {
      timer(() => resolve(fail(TIMEOUT)), timeoutMs);
    });
    return Promise.race([answer, late]).catch(() => fail(REASONS.SEAM));
  } catch (_err) {
    return Promise.resolve(fail(REASONS.SEAM));
  }
}

const NOT_FOUND = "NOT_FOUND";
const NOT_OWNER = "NOT_OWNER";

function orderStateOf(o, playerId, orderId) {
  if (!isObj(o) || !isObj(o.row) || o.owner_id === undefined) return fail(REASONS.SEAM);
  const row = o.row;
  const id = idOrNull(row.order_id ?? o.order_id);
  const typeId = intOf(row.type_id);
  if ((id !== null && id !== orderId) || !isId(typeId)) return fail(REASONS.SEAM);
  if (o.is_corp === true || intOf(o.owner_id) !== playerId) return fail(NOT_OWNER);
  const raw = stateOf(o);
  const state = raw === ORDER_OPEN || ORDER_FINAL_STATES.includes(raw) ? raw : "unknown";
  return { ok: true, state, side: row.bid ? "buy" : "sell", typeId, total: Math.max(0, intOf(row.vol_entered)),
    changedAtMs: msOfIso(o.last_state_change_at) };
}

function readOrderStateFrom(mods, playerId, orderId, opts) {
  if (!isId(orderId)) return Promise.resolve(fail(REASONS.SEAM));
  return daemonRead(mods, playerId, opts, "GetOrder", { order_id: String(orderId) },
    (result) => orderStateOf(result, playerId, orderId),
    (err) => (String(err && err.message ? err.message : err).includes(`order ${orderId} not found`)
      ? fail(NOT_FOUND) : fail(REASONS.SEAM)));
}

module.exports = { readCargoFrom, readFittingFrom, readPilotFrom, readAssetsFrom, readFindItemFrom,
  readWalletHistoryFrom, readWalletIncomeFrom, INCOME_SOURCES, readSkillQueueFrom, readStandingsFrom, readKillmailsFrom, readMissionsFrom,
  readIndustryJobsFrom, readMarketOrdersFrom, readOrderStateFrom, readSkillHistoryFrom, SKILL_DONE_EVENTS, RACKS,
  LOCATION_RANGES };
