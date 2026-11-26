"use strict";

const { isId } = require("./tradeContracts");

const SEED_ORDER_ID_MIN = 4000000000000000000n;

function errorText(err) {
  return String(err && err.message ? err.message : err || "");
}

function orderIdKey(orderId) {
  if (orderId === undefined || orderId === null) return null;
  try {
    const big = BigInt(String(orderId).trim());
    return big > 0n ? big.toString() : null;
  } catch (_err) {
    return null;
  }
}

function orderIdText(orderId) {
  return orderIdKey(orderId) || String(orderId);
}

function compareOrderIds(a, b) {
  const aa = BigInt(a);
  const bb = BigInt(b);
  return aa < bb ? -1 : (aa > bb ? 1 : 0);
}

function escrowTypeOf(record) {
  return String(record && record.escrowType ? record.escrowType : "").trim().toLowerCase();
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstDefined(...values) {
  for (const v of values) if (v !== undefined && v !== null) return v;
  return undefined;
}

// Pure port of vendor buildNativeStationMetadata (marketProxyService.js:1149-1158), given the station row of space/worldData.getStationByID.
function stationMetadataFrom(station, stationId) {
  if (!station || typeof station !== "object") return undefined;
  if (Number(station.stationID) !== Number(stationId) || station.isStructure) return undefined;
  return {
    station_id: Number(station.stationID), solar_system_id: Number(station.solarSystemID),
    constellation_id: Number(station.constellationID), region_id: Number(station.regionID),
    station_name: String(station.stationName || ""), security: Number(station.security || 0),
  };
}

function buildBuyOrderCall(p, stationMetadata) {
  const bad = (detail) => ({ ok: false, reason: "MARKET_CALL_INVALID", detail });

  if (!p || typeof p !== "object") return bad("payload");
  if (!isId(p.corporationId)) return bad("corporationId");
  if (!isId(p.stationId)) return bad("stationId");
  if (!isId(p.typeId)) return bad("typeId");
  if (!isId(p.quantity)) return bad("quantity");
  if (!Number.isSafeInteger(p.priceCents) || p.priceCents < 1) return bad("priceCents");
  if (!Number.isInteger(p.durationDays)) return bad("durationDays");
  if (!Number.isInteger(p.minVolume) || p.minVolume < 1 || p.minVolume > p.quantity) return bad("minVolume");

  const params = {
    owner_id: p.corporationId,
    is_corp: true,
    station_id: p.stationId,
  };
  if (stationMetadata && typeof stationMetadata === "object") params.station_metadata = stationMetadata;
  Object.assign(params, {
    type_id: p.typeId,
    price: p.priceCents / 100,
    quantity: p.quantity,
    min_volume: p.minVolume,
    duration_days: p.durationDays,
    range_value: -1,
    bid: true,
    source: "player",
  });
  return { ok: true, params };
}

const DAEMON_RPC_REJECTED = "MARKET_DAEMON_RPC_REJECTED";
const DAEMON_UNAVAILABLE_PHRASES = [
  "market daemon rpc connect timeout",
  "market daemon rpc socket closed before connect",
  "market daemon rpc connection is not ready",
  "market daemon rpc connection closed",
  "market daemon rpc request timed out",
  "econnrefused",
  "econnreset",
  "enetunreach",
  "ehostunreach",
];

function isDaemonOutcomeUnknown(err) {
  return Boolean(err && err.marketDaemonOutcomeUnknown === true);
}

function isDaemonRejection(err) {
  return Boolean(err && err.code === DAEMON_RPC_REJECTED && err.marketDaemonOutcomeUnknown === false);
}

function isDaemonUnavailable(err) {
  if (isDaemonOutcomeUnknown(err)) return true;
  if (err && err.marketDaemonRequestSent === false) return true;
  const msg = errorText(err).toLowerCase();
  return DAEMON_UNAVAILABLE_PHRASES.some((phrase) => msg.includes(phrase));
}

function isDaemonMissingOrder(err, orderId) {
  return errorText(err) === `order ${orderIdText(orderId)} not found`;
}

function orderRowOf(order) {
  if (!order || typeof order !== "object") return null;
  const row = order.row && typeof order.row === "object" ? order.row : order;
  const pick = (...names) => firstDefined(...names.map((n) => row[n]), ...names.map((n) => order[n]));
  const state = String(firstDefined(order.state, row.state, "open")).trim().toLowerCase();
  return {
    order_id: pick("order_id", "orderId"),
    owner_id: numberOr(firstDefined(order.owner_id, row.owner_id), 0),
    is_corp: Boolean(firstDefined(order.is_corp, row.is_corp)),
    state,
    bid: Boolean(pick("bid")),
    source: String(firstDefined(pick("source"), "")).trim().toLowerCase(),
    station_id: numberOr(pick("station_id", "stationId"), 0),
    type_id: numberOr(pick("type_id", "typeId"), 0),
    price: numberOr(pick("price"), 0),
    vol_entered: numberOr(pick("vol_entered", "volEntered"), 0),
    vol_remaining: numberOr(pick("vol_remaining", "volRemaining"), 0),
    issued_at: String(firstDefined(pick("issued_at", "issuedAt"), "")),
    duration_days: numberOr(pick("duration_days", "durationDays"), 0),
  };
}

const ORDER_STATES = new Set(["open", "filled", "cancelled", "expired"]);

function mapOrder(row) {
  return {
    state: ORDER_STATES.has(row.state) ? row.state : "other",
    volRemaining: row.vol_remaining,
    volEntered: row.vol_entered,
    priceCents: Math.round(row.price * 100),
    issuedAt: row.issued_at,
    durationDays: row.duration_days,
    stationId: row.station_id,
    typeId: row.type_id,
    ownerId: row.owner_id,
    isCorp: row.is_corp,
    bid: row.bid,
    source: row.source || "player",
  };
}

const ESCROW_STATE_PLACING = "placing";
const ESCROW_STATE_ACTIVE = "active";

function escrowStateOf(record) {
  const state = String(record && record.escrowState ? record.escrowState : "").trim().toLowerCase();
  return state || ESCROW_STATE_ACTIVE;
}

function mapEscrow(record) {
  if (!record || typeof record !== "object") return null;
  const accountKey = Number.isSafeInteger(record.accountKey) ? record.accountKey : null;
  const type = escrowTypeOf(record);
  return {
    escrowType: type,
    ...(type === "sell" ? { escrowState: escrowStateOf(record) } : {}),
    ownerId: numberOr(record.ownerId, 0),
    accountKey,
    remainingQuantity: numberOr(record.remainingQuantity, 0),
    escrowAmount: numberOr(record.escrowAmount, 0),
    pendingFill: Boolean(record.pendingFill),
    lneOfferId: typeof record.lneOfferId === "string" && record.lneOfferId ? record.lneOfferId : null,
  };
}

function openPlayerBidKey(row) {
  if (!row || row.state !== "open" || !row.bid || row.source === "seed") return null;
  const key = orderIdKey(row.order_id);
  if (key === null || BigInt(key) >= SEED_ORDER_ID_MIN) return null;
  return key;
}

function openPlayerAskKey(row) {
  if (!row || row.state !== "open" || row.bid || row.source === "seed") return null;
  const key = orderIdKey(row.order_id);
  if (key === null || BigInt(key) >= SEED_ORDER_ID_MIN) return null;
  return key;
}

function ordersOf(result) {
  if (Array.isArray(result)) return result;
  return result && Array.isArray(result.data) ? result.data : [];
}

async function getOrderFrom(daemon, orderId) {
  let result;
  try {
    result = await daemon.call("GetOrder", { order_id: orderIdText(orderId) });
  } catch (err) {
    if (isDaemonMissingOrder(err, orderId)) return { ok: true, missing: true, order: null };
    return { ok: false, reason: "MARKET_UNAVAILABLE", detail: errorText(err) };
  }
  try {
    if (!result || typeof result !== "object") {
      return { ok: false, reason: "MARKET_UNAVAILABLE", detail: "empty_response" };
    }
    return { ok: true, missing: false, order: mapOrder(orderRowOf(result)) };
  } catch (err) {
    return { ok: false, reason: "MARKET_UNAVAILABLE", detail: errorText(err) };
  }
}

async function placeBuyOrderFrom(daemon, params) {
  if (!daemon || typeof daemon.call !== "function")
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, ambiguous: false };
  let result;
  try {
    result = await daemon.call("PlaceOrder", params);
  } catch (err) {
    const detail = errorText(err);
    if (isDaemonRejection(err)) return { ok: false, reason: "MARKET_PLACE_FAILED", permanent: true, ambiguous: false, detail };
    if (isDaemonOutcomeUnknown(err)) return { ok: false, reason: "MARKET_UNAVAILABLE", permanent: false, ambiguous: true, detail };
    if (isDaemonUnavailable(err)) return { ok: false, reason: "MARKET_UNAVAILABLE", permanent: false, ambiguous: false, detail };
    return { ok: false, reason: "MARKET_PLACE_FAILED", permanent: false, ambiguous: true, detail };
  }
  const raw = result && typeof result === "object" ? firstDefined(result.order_id, result.orderId) : undefined;
  const key = orderIdKey(raw);
  if (key === null) {
    return { ok: false, reason: "MARKET_PLACE_FAILED", permanent: false, ambiguous: true, detail: "no_order_id" };
  }
  return { ok: true, orderId: key };
}

async function readBuyOrderFrom(daemon, escrowState, orderId) {
  if (!daemon || typeof daemon.call !== "function")
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  if (!escrowState || typeof escrowState.getEscrowRecord !== "function")
    return { ok: false, reason: "SEAM_UNAVAILABLE" };

  const got = await getOrderFrom(daemon, orderId);
  if (!got.ok) return got;
  try {
    const escrow = mapEscrow(escrowState.getEscrowRecord(orderIdText(orderId)));
    return { ok: true, missing: got.missing, order: got.order, escrow };
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: errorText(err) };
  }
}

async function findBuyOrderFrom(daemon, escrowState, spec) {
  if (!daemon || typeof daemon.call !== "function")
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  if (!escrowState || typeof escrowState.listEscrowRecords !== "function"
    || typeof escrowState.getEscrowRecord !== "function")
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  const { corporationId, offerId, stationId, typeId, quantity, priceCents } = spec || {};
  if (typeof offerId !== "string" || !offerId || !isId(corporationId))
    return { ok: false, reason: "MARKET_CALL_INVALID", detail: "spec" };

  let tagged;
  try {
    tagged = (escrowState.listEscrowRecords() || [])
      .filter((rec) => rec && escrowTypeOf(rec) === "buy" && rec.lneOfferId === offerId)
      .map((rec) => orderIdKey(rec.orderId))
      .filter((key) => key !== null)
      .sort(compareOrderIds);
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: errorText(err) };
  }
  if (tagged.length > 0) {
    return { ok: true, found: "escrow", orderId: tagged[0], duplicates: tagged.length - 1, extraOrderIds: tagged.slice(1) };
  }

  let result;
  try {
    result = await daemon.call("GetCorporationOrders", { owner_id: corporationId, is_corp: true });
  } catch (err) {
    return { ok: false, reason: "MARKET_UNAVAILABLE", detail: errorText(err) };
  }
  try {
    const matches = [];
    for (const o of ordersOf(result)) {
      const row = orderRowOf(o);
      const key = openPlayerBidKey(row);
      if (key === null) continue;
      if (row.station_id !== stationId || row.type_id !== typeId) continue;
      if (row.vol_entered !== quantity) continue;
      if (Math.round(row.price * 100) !== priceCents) continue;
      if (escrowState.getEscrowRecord(key)) continue;
      matches.push(key);
    }
    matches.sort(compareOrderIds);
    if (matches.length > 0) {
      return { ok: true, found: "daemon", orderId: matches[0], duplicates: matches.length - 1, extraOrderIds: matches.slice(1) };
    }
    return { ok: true, found: null, duplicates: 0, extraOrderIds: [] };
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: errorText(err) };
  }
}

function attachBuyEscrowFrom(escrowState, spec) {
  if (!escrowState || typeof escrowState.getEscrowRecord !== "function"
    || typeof escrowState.putEscrowRecordDurable !== "function")
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  const s = spec || {};
  const bad = (detail) => ({ ok: false, reason: "MARKET_CALL_INVALID", detail });
  const orderId = orderIdKey(s.orderId);
  if (orderId === null) return bad("orderId");
  if (!isId(s.ownerId)) return bad("ownerId");
  if (!isId(s.typeId)) return bad("typeId");
  if (!isId(s.stationId)) return bad("stationId");
  if (!Number.isSafeInteger(s.priceCents) || s.priceCents < 1) return bad("priceCents");
  if (!isId(s.remainingQuantity)) return bad("remainingQuantity");
  if (typeof s.lneOfferId !== "string" || !s.lneOfferId) return bad("lneOfferId");
  if (s.accountKey !== null && s.accountKey !== undefined && !isId(s.accountKey)) return bad("accountKey");
  if (!Number.isFinite(s.at)) return bad("at");

  try {
    const existing = escrowState.getEscrowRecord(orderId);
    if (existing) {
      if (existing.lneOfferId === s.lneOfferId && escrowTypeOf(existing) === "buy") return { ok: true, outcome: "PRESENT" };
      return { ok: false, reason: "ESCROW_FOREIGN" };
    }
    const iso = new Date(s.at).toISOString();
    const record = {
      orderId,
      ownerId: s.ownerId,
      isCorp: true,
      walletOwnerId: s.ownerId,
      accountKey: s.accountKey === undefined ? null : s.accountKey,
      escrowType: "buy",
      typeId: s.typeId,
      stationId: s.stationId,
      price: s.priceCents / 100,
      remainingQuantity: s.remainingQuantity,
      escrowAmount: Math.round(s.priceCents * s.remainingQuantity) / 100,
      issuedAt: String(s.issuedAt || ""),
      durationDays: Number.isSafeInteger(s.durationDays) ? s.durationDays : 0,
      fillAttemptSequence: 0,
      pendingFill: null,
      createdAt: iso,
      updatedAt: iso,
      lneOfferId: s.lneOfferId,
    };
    const result = escrowState.putEscrowRecordDurable(record);
    if (!result || result.success !== true) {
      return { ok: false, reason: "ESCROW_WRITE_FAILED", detail: result && result.errorMsg ? String(result.errorMsg) : "write" };
    }
    return { ok: true, outcome: "WRITTEN" };
  } catch (err) {
    return { ok: false, reason: "ESCROW_WRITE_FAILED", detail: errorText(err) };
  }
}

function detachBuyEscrowFrom(escrowState, spec) {
  return detachEscrowFrom(escrowState, { ...(spec || {}), escrowType: "buy" });
}

function detachEscrowFrom(escrowState, spec) {
  if (!escrowState || typeof escrowState.getEscrowRecord !== "function"
    || typeof escrowState.listEscrowRecords !== "function"
    || typeof escrowState.removeEscrowRecordDurable !== "function")
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  const { orderId: rawOrderId, offerId } = spec || {};
  const wantType = spec && spec.escrowType !== undefined ? spec.escrowType : "buy";
  const orderId = orderIdKey(rawOrderId);
  if (orderId === null || typeof offerId !== "string" || !offerId || (wantType !== "buy" && wantType !== "sell"))
    return { ok: false, reason: "MARKET_CALL_INVALID", detail: "spec" };

  let record;
  let busy;
  try {
    record = escrowState.getEscrowRecord(orderId);
    if (!record) return { ok: true, outcome: "ABSENT" };
    if (record.lneOfferId !== offerId || escrowTypeOf(record) !== wantType) return { ok: false, reason: "ESCROW_FOREIGN" };
    if (record.pendingFill) return { ok: false, reason: "ESCROW_BUSY" };
    busy = (escrowState.listEscrowRecords() || []).some((rec) => {
      const saga = rec && rec.pendingFill;
      return Boolean(saga && (orderIdKey(saga.orderID) === orderId || orderIdKey(saga.crossingOrderID) === orderId));
    });
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: errorText(err) };
  }
  if (busy) return { ok: false, reason: "ESCROW_BUSY" };

  try {
    const result = escrowState.removeEscrowRecordDurable(orderId);
    if (!result || result.success !== true) {
      return { ok: false, reason: "ESCROW_WRITE_FAILED", detail: result && result.errorMsg ? String(result.errorMsg) : "remove" };
    }
    return { ok: true, outcome: "REMOVED" };
  } catch (err) {
    return { ok: false, reason: "ESCROW_WRITE_FAILED", detail: errorText(err) };
  }
}

async function cancelBuyOrderFrom(daemon, orderId) {
  if (!daemon || typeof daemon.call !== "function")
    return { ok: false, reason: "SEAM_UNAVAILABLE" };

  let cancelErr = null;
  let response = null;
  try {
    response = await daemon.call("CancelOrder", { order_id: orderIdText(orderId) });
  } catch (err) {
    if (isDaemonMissingOrder(err, orderId)) return { ok: true, state: "missing" };
    cancelErr = err;
  }

  const got = await getOrderFrom(daemon, orderId);
  if (got.ok && got.missing) return { ok: true, state: "missing" };
  if (got.ok && got.order.state !== "open") return { ok: true, state: got.order.state };
  if (got.ok) {
    if (cancelErr && isDaemonUnavailable(cancelErr))
      return { ok: false, reason: "MARKET_UNAVAILABLE", detail: errorText(cancelErr) };
    return { ok: false, reason: "MARKET_CANCEL_FAILED", detail: cancelErr ? errorText(cancelErr) : "still_open" };
  }
  if (!cancelErr) {
    const state = response && typeof response.state === "string" ? response.state : "";
    if (state && state !== "open") return { ok: true, state, verified: false };
  }
  return { ok: false, reason: "MARKET_UNAVAILABLE", detail: cancelErr ? errorText(cancelErr) : got.detail };
}

async function placeAndAttachBuyOrderFrom(daemon, escrowState, spec, nowMs, stationMetadata) {
  const flags = (res, permanent, ambiguous) => ({ ...res, permanent, ambiguous });
  const call = buildBuyOrderCall(spec, stationMetadata);
  if (!call.ok) return flags(call, true, false);
  try {
    const findRes = await findBuyOrderFrom(daemon, escrowState, spec);
    if (!findRes.ok) return flags(findRes, false, false);
    if (findRes.found === "escrow") return { ok: true, orderId: findRes.orderId, duplicate: true };

    let orderId;
    if (findRes.found === "daemon") {
      orderId = findRes.orderId;
    } else {
      const placeRes = await placeBuyOrderFrom(daemon, call.params);
      if (!placeRes.ok) return placeRes;
      orderId = placeRes.orderId;
    }

    const readRes = await readBuyOrderFrom(daemon, escrowState, orderId);
    if (!readRes.ok || !readRes.order) {
      if (findRes.found !== "daemon") await cancelBuyOrderFrom(daemon, orderId);
      return { ok: false, reason: "MARKET_READ_FAILED", permanent: false, ambiguous: true,
        detail: readRes.ok ? "missing" : readRes.reason };
    }
    const attachRes = attachBuyEscrowFrom(escrowState, {
      orderId,
      ownerId: spec.corporationId,
      accountKey: spec.accountKey === undefined ? null : spec.accountKey,
      typeId: spec.typeId,
      stationId: spec.stationId,
      priceCents: spec.priceCents,
      remainingQuantity: readRes.order.volRemaining,
      issuedAt: readRes.order.issuedAt,
      durationDays: readRes.order.durationDays,
      lneOfferId: spec.offerId,
      at: nowMs,
    });
    if (!attachRes.ok) {
      await cancelBuyOrderFrom(daemon, orderId);
      return { ok: false, reason: "MARKET_ATTACH_FAILED", permanent: false, ambiguous: false, detail: attachRes.reason };
    }
    if (findRes.found === "daemon" && Array.isArray(findRes.extraOrderIds)) {
      for (const extraId of findRes.extraOrderIds) await cancelBuyOrderFrom(daemon, extraId);
    }
    return { ok: true, orderId };
  } catch (err) {
    return { ok: false, reason: "MARKET_UNAVAILABLE", permanent: false, ambiguous: true, detail: errorText(err) };
  }
}

async function listCorpBuyOrdersFrom(daemon, escrowState, corporationId) {
  const all = await listCorpOrdersFrom(daemon, escrowState, corporationId);
  if (!all.ok) return all;
  return { ok: true, orders: all.orders.filter((o) => o.bid).map(({ bid: _bid, ...rest }) => rest) };
}

async function listCorpOrdersFrom(daemon, escrowState, corporationId) {
  if (!daemon || typeof daemon.call !== "function")
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  if (!escrowState || typeof escrowState.getEscrowRecord !== "function")
    return { ok: false, reason: "SEAM_UNAVAILABLE" };

  let result;
  try {
    result = await daemon.call("GetCorporationOrders", { owner_id: corporationId, is_corp: true });
  } catch (err) {
    return { ok: false, reason: "MARKET_UNAVAILABLE", detail: errorText(err) };
  }
  try {
    const listed = [];
    for (const o of ordersOf(result)) {
      const row = orderRowOf(o);
      const orderId = row.bid ? openPlayerBidKey(row) : openPlayerAskKey(row);
      if (orderId === null) continue;
      const escrow = escrowState.getEscrowRecord(orderId) || null;
      listed.push({
        orderId,
        bid: row.bid,
        stationId: row.station_id,
        typeId: row.type_id,
        volRemaining: row.vol_remaining,
        hasEscrow: escrow !== null,
        lneOfferId: escrow && typeof escrow.lneOfferId === "string" && escrow.lneOfferId ? escrow.lneOfferId : null,
      });
    }
    listed.sort((a, b) => compareOrderIds(a.orderId, b.orderId));
    return { ok: true, orders: listed };
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: errorText(err) };
  }
}

function listTaggedEscrowsFrom(escrowState, spec) {
  if (!escrowState || typeof escrowState.listEscrowRecords !== "function")
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  const { limit, afterOrderId } = spec || {};
  if (!isId(limit)) return { ok: false, reason: "MARKET_CALL_INVALID", detail: "limit" };
  let after = 0n;
  if (afterOrderId !== undefined && afterOrderId !== null && String(afterOrderId) !== "0") {
    const key = orderIdKey(afterOrderId);
    if (key === null) return { ok: false, reason: "MARKET_CALL_INVALID", detail: "afterOrderId" };
    after = BigInt(key);
  }

  try {
    const matches = [];
    for (const rec of escrowState.listEscrowRecords() || []) {
      if (!rec || typeof rec.lneOfferId !== "string" || !rec.lneOfferId) continue;
      const key = orderIdKey(rec.orderId);
      if (key === null || BigInt(key) <= after) continue;
      matches.push({
        orderId: key,
        lneOfferId: rec.lneOfferId,
        ownerId: numberOr(rec.ownerId, 0),
        pendingFill: Boolean(rec.pendingFill),
        escrowType: escrowTypeOf(rec),
        stationId: numberOr(rec.stationId, 0),
        typeId: numberOr(rec.typeId, 0),
      });
    }
    matches.sort((a, b) => compareOrderIds(a.orderId, b.orderId));
    return { ok: true, escrows: matches.slice(0, limit), truncated: matches.length > limit };
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: errorText(err) };
  }
}

const sellEscrowKey = (offerId, orderId, itemId) => `lne:trade:${offerId}:msplace:${orderId}:${itemId}`;
const sellReturnKey = (offerId, orderId, itemId) => `lne:trade:${offerId}:mret:${orderId}:${itemId}`;

function buildSellOrderCall(p, stationMetadata) {
  const bad = (detail) => ({ ok: false, reason: "MARKET_CALL_INVALID", detail });
  if (!p || typeof p !== "object") return bad("payload");
  if (!isId(p.corporationId)) return bad("corporationId");
  if (!isId(p.stationId)) return bad("stationId");
  if (!isId(p.typeId)) return bad("typeId");
  if (!isId(p.quantity)) return bad("quantity");
  if (!Number.isSafeInteger(p.priceCents) || p.priceCents < 1) return bad("priceCents");
  if (!Number.isInteger(p.durationDays)) return bad("durationDays");
  const params = { owner_id: p.corporationId, is_corp: true, station_id: p.stationId };
  if (stationMetadata && typeof stationMetadata === "object") params.station_metadata = stationMetadata;
  Object.assign(params, {
    type_id: p.typeId,
    price: p.priceCents / 100,
    quantity: p.quantity,
    min_volume: 1,
    duration_days: p.durationDays,
    range_value: -1,
    bid: false,
    source: "player",
  });
  return { ok: true, params };
}

async function findSellOrderFrom(daemon, escrowState, spec) {
  if (!daemon || typeof daemon.call !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
  if (!escrowState || typeof escrowState.listEscrowRecords !== "function"
    || typeof escrowState.getEscrowRecord !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
  const { corporationId, offerId, stationId, typeId, quantity, priceCents } = spec || {};
  if (typeof offerId !== "string" || !offerId || !isId(corporationId))
    return { ok: false, reason: "MARKET_CALL_INVALID", detail: "spec" };

  let tagged;
  try {
    tagged = (escrowState.listEscrowRecords() || [])
      .filter((rec) => rec && escrowTypeOf(rec) === "sell" && rec.lneOfferId === offerId)
      .map((rec) => ({ key: orderIdKey(rec.orderId), state: escrowStateOf(rec) }))
      .filter((r) => r.key !== null)
      .sort((a, b) => compareOrderIds(a.key, b.key));
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: errorText(err) };
  }
  if (tagged.length > 0) {
    return { ok: true, found: "escrow", orderId: tagged[0].key, escrowState: tagged[0].state,
      duplicates: tagged.length - 1, extraOrderIds: tagged.slice(1).map((r) => r.key) };
  }

  let result;
  try {
    result = await daemon.call("GetCorporationOrders", { owner_id: corporationId, is_corp: true });
  } catch (err) {
    return { ok: false, reason: "MARKET_UNAVAILABLE", detail: errorText(err) };
  }
  try {
    const matches = [];
    for (const o of ordersOf(result)) {
      const row = orderRowOf(o);
      const key = openPlayerAskKey(row);
      if (key === null) continue;
      if (row.station_id !== stationId || row.type_id !== typeId) continue;
      if (row.vol_entered !== quantity) continue;
      if (Math.round(row.price * 100) !== priceCents) continue;
      if (escrowState.getEscrowRecord(key)) continue;
      matches.push(key);
    }
    matches.sort(compareOrderIds);
    if (matches.length > 0) {
      return { ok: true, found: "daemon", orderId: matches[0], duplicates: matches.length - 1, extraOrderIds: matches.slice(1) };
    }
    return { ok: true, found: null, duplicates: 0, extraOrderIds: [] };
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: errorText(err) };
  }
}

function attachSellEscrowFrom(escrowState, spec) {
  if (!escrowState || typeof escrowState.getEscrowRecord !== "function"
    || typeof escrowState.putEscrowRecordDurable !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
  const s = spec || {};
  const bad = (detail) => ({ ok: false, reason: "MARKET_CALL_INVALID", detail });
  const orderId = orderIdKey(s.orderId);
  if (orderId === null) return bad("orderId");
  if (!isId(s.corporationId)) return bad("corporationId");
  if (!isId(s.typeId)) return bad("typeId");
  if (!isId(s.stationId)) return bad("stationId");
  if (!isId(s.quantity)) return bad("quantity");
  if (!isId(s.escrowLocationId)) return bad("escrowLocationId");
  if (!Number.isSafeInteger(s.hangarFlag) || s.hangarFlag < 0) return bad("hangarFlag");
  if (typeof s.lneOfferId !== "string" || !s.lneOfferId) return bad("lneOfferId");
  if (s.accountKey !== null && s.accountKey !== undefined && !isId(s.accountKey)) return bad("accountKey");
  if (!Number.isFinite(s.at)) return bad("at");
  try {
    const existing = escrowState.getEscrowRecord(orderId);
    if (existing) {
      if (existing.lneOfferId === s.lneOfferId && escrowTypeOf(existing) === "sell") return { ok: true, outcome: "PRESENT" };
      return { ok: false, reason: "ESCROW_FOREIGN" };
    }
    const iso = new Date(s.at).toISOString();
    const record = {
      orderId,
      ownerId: s.corporationId,
      sourceOwnerId: s.corporationId,
      sourceLocationId: s.stationId,
      sourceFlagId: s.hangarFlag,
      isCorp: true,
      walletOwnerId: s.corporationId,
      accountKey: s.accountKey === undefined ? null : s.accountKey,
      typeId: s.typeId,
      stationId: s.stationId,
      escrowLocationID: s.escrowLocationId,
      remainingQuantity: s.quantity,
      issuedAt: iso,
      durationDays: Number.isSafeInteger(s.durationDays) ? s.durationDays : 0,
      createdAt: iso,
      updatedAt: iso,
      escrowType: "sell",
      escrowState: ESCROW_STATE_PLACING,
      lneOfferId: s.lneOfferId,
    };
    const result = escrowState.putEscrowRecordDurable(record);
    if (!result || result.success !== true) {
      return { ok: false, reason: "ESCROW_WRITE_FAILED", detail: result && result.errorMsg ? String(result.errorMsg) : "write" };
    }
    return { ok: true, outcome: "WRITTEN" };
  } catch (err) {
    return { ok: false, reason: "ESCROW_WRITE_FAILED", detail: errorText(err) };
  }
}

function promoteSellEscrowFrom(escrowState, spec) {
  if (!escrowState || typeof escrowState.getEscrowRecord !== "function"
    || typeof escrowState.putEscrowRecordDurable !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
  const { orderId: rawOrderId, offerId, at } = spec || {};
  const orderId = orderIdKey(rawOrderId);
  if (orderId === null || typeof offerId !== "string" || !offerId || !Number.isFinite(at))
    return { ok: false, reason: "MARKET_CALL_INVALID", detail: "spec" };
  try {
    const rec = escrowState.getEscrowRecord(orderId);
    if (!rec) return { ok: false, reason: "ESCROW_GONE" };
    if (rec.lneOfferId !== offerId || escrowTypeOf(rec) !== "sell") return { ok: false, reason: "ESCROW_FOREIGN" };
    if (escrowStateOf(rec) === ESCROW_STATE_ACTIVE) return { ok: true, outcome: "PRESENT" };
    const result = escrowState.putEscrowRecordDurable({ ...rec, escrowState: ESCROW_STATE_ACTIVE,
      updatedAt: new Date(at).toISOString() });
    if (!result || result.success !== true) {
      return { ok: false, reason: "ESCROW_WRITE_FAILED", detail: result && result.errorMsg ? String(result.errorMsg) : "write" };
    }
    return { ok: true, outcome: "WRITTEN" };
  } catch (err) {
    return { ok: false, reason: "ESCROW_WRITE_FAILED", detail: errorText(err) };
  }
}

function stacksAt(itemStore, ownerId, locationId, flag, typeId) {
  const items = itemStore.listContainerItems(ownerId, locationId, flag, [typeId]) || [];
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && numberOr(it.ownerID, 0) === ownerId && numberOr(it.typeID, 0) === typeId)
    .map((it) => ({ item: it, itemId: numberOr(it.itemID, 0),
      quantity: Number(it.singleton) === 1 ? 1 : numberOr(it.stacksize ?? it.quantity, 0) }))
    .filter((st) => isId(st.itemId) && st.quantity > 0)
    .sort((a, b) => a.itemId - b.itemId);
}

function sellSeamConstants(seams) {
  const s = seams || {};
  const reasons = s.itemCustody && s.itemCustody.CUSTODY_REASON;
  const flags = s.itemStore && s.itemStore.ITEM_FLAGS;
  if (!reasons || typeof reasons.MARKET_ESCROW_PLACE !== "string" || typeof reasons.MARKET_ESCROW_RETURN !== "string"
    || !flags || !Number.isSafeInteger(flags.HANGAR)) return null;
  if (!s.marketCustody || typeof s.marketCustody.transferItem !== "function"
    || typeof s.marketCustody.getEscrowLocationID !== "function") return null;
  if (!s.itemStore || typeof s.itemStore.listContainerItems !== "function"
    || typeof s.itemStore.findItemById !== "function") return null;
  return { place: reasons.MARKET_ESCROW_PLACE, ret: reasons.MARKET_ESCROW_RETURN, hangar: flags.HANGAR };
}

function returnSellEscrowFrom(seams, spec) {
  const c = sellSeamConstants(seams);
  const es = seams && seams.escrowState;
  if (c === null || !es || typeof es.getEscrowRecord !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
  const { offerId, orderId: rawOrderId, corporationId, stationId, typeId } = spec || {};
  const orderId = orderIdKey(rawOrderId);
  if (orderId === null || typeof offerId !== "string" || !offerId || !isId(corporationId) || !isId(stationId)
    || !isId(typeId)) return { ok: false, reason: "MARKET_CALL_INVALID", detail: "spec" };
  try {
    if (es.getEscrowRecord(orderId)) return { ok: false, reason: "ESCROW_PRESENT" };
    const escrowLoc = seams.marketCustody.getEscrowLocationID(orderId);
    if (!isId(escrowLoc)) return { ok: false, reason: "MARKET_CALL_INVALID", detail: "escrowLocation" };
    const moved = [];
    for (const st of stacksAt(seams.itemStore, corporationId, escrowLoc, c.hangar, typeId)) {
      const res = seams.marketCustody.transferItem({
        item: st.item, ownerID: corporationId, locationID: stationId, flagID: c.hangar, orderID: orderId,
        actor: corporationId, reason: c.ret, idempotencyKey: sellReturnKey(offerId, orderId, st.itemId),
      });
      if (!res || res.success !== true) {
        return { ok: false, reason: "CUSTODY_FAILED", detail: String((res && res.errorMsg) || "no_result").slice(0, 120) };
      }
      moved.push({ itemId: st.itemId, quantity: st.quantity });
    }
    return { ok: true, moved: moved.length, units: moved.reduce((n, st) => n + st.quantity, 0), stacks: moved };
  } catch (err) {
    return { ok: false, reason: "CUSTODY_FAILED", detail: errorText(err) };
  }
}

async function placeAndAttachSellOrderFrom(seams, spec, nowMs, stationMetadata) {
  const flags = (res, permanent, ambiguous) => ({ ...res, permanent, ambiguous });
  const s = seams || {};
  const c = sellSeamConstants(s);
  if (c === null) return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, ambiguous: false };
  const call = buildSellOrderCall(spec, stationMetadata);
  if (!call.ok) return flags(call, true, false);
  const granted = new Set(Array.isArray(spec.grantItemIds) ? spec.grantItemIds.filter(isId) : []);
  const corp = spec.corporationId;
  const Q = spec.quantity;

  let orderId = null;
  let placedHere = false;
  try {
    const findRes = await findSellOrderFrom(s.daemon, s.escrowState, spec);
    if (!findRes.ok) return flags(findRes, false, false);
    if (findRes.found === "escrow" && findRes.escrowState === ESCROW_STATE_ACTIVE) {
      return { ok: true, orderId: findRes.orderId, duplicate: true };
    }
    const attach = (id) => attachSellEscrowFrom(s.escrowState, {
      orderId: id, corporationId: corp, accountKey: spec.accountKey === undefined ? null : spec.accountKey,
      typeId: spec.typeId, stationId: spec.stationId, quantity: Q, durationDays: spec.durationDays,
      escrowLocationId: s.marketCustody.getEscrowLocationID(id), lneOfferId: spec.offerId, at: nowMs,
      hangarFlag: c.hangar,
    });
    if (findRes.found === "escrow") {
      orderId = findRes.orderId;
    } else {
      if (findRes.found === "daemon") {
        orderId = findRes.orderId;
      } else {
        const placeRes = await placeBuyOrderFrom(s.daemon, call.params);
        if (!placeRes.ok) return placeRes;
        orderId = placeRes.orderId;
        placedHere = true;
      }
      const att = attach(orderId);
      if (!att.ok) {
        const permanent = att.reason === "MARKET_CALL_INVALID";
        const detail = att.detail || att.reason;
        if (placedHere) {
          const cr = await cancelBuyOrderFrom(s.daemon, orderId);
          if (!cr || cr.ok !== true) {
            return { ok: false, reason: "MARKET_ATTACH_FAILED", permanent, ambiguous: true, rollbackFailed: "CANCEL",
              detail: `${detail}:cancel:${(cr && cr.reason) || "no_result"}` };
          }
        }
        return { ok: false, reason: "MARKET_ATTACH_FAILED", permanent, ambiguous: false, detail };
      }
    }

    const escrowLoc = s.marketCustody.getEscrowLocationID(orderId);
    let failure = null;
    if (!isId(escrowLoc)) {
      failure = { detail: "escrowLocation", permanent: true, reason: "MARKET_CALL_INVALID" };
    } else {
      const unitsIn = () => stacksAt(s.itemStore, corp, escrowLoc, c.hangar, spec.typeId)
        .reduce((n, st) => n + st.quantity, 0);
      let rest = Q - unitsIn();
      if (rest > 0) {
        const pin = { ownerID: corp, locationID: spec.stationId, flagID: c.hangar };
        for (const st of stacksAt(s.itemStore, corp, spec.stationId, c.hangar, spec.typeId)) {
          if (rest <= 0) break;
          if (!granted.has(st.itemId)) continue;
          const take = Math.min(st.quantity, rest);
          const res = s.marketCustody.transferItem({
            item: s.itemStore.findItemById(st.itemId), expectedSource: pin, locationID: escrowLoc, flagID: c.hangar,
            quantity: take, orderID: orderId, actor: corp, reason: c.place,
            idempotencyKey: sellEscrowKey(spec.offerId, orderId, st.itemId),
          });
          if (!res || res.success !== true) {
            failure = { detail: String((res && res.errorMsg) || "no_result").slice(0, 120), permanent: false };
            break;
          }
          rest -= take;
        }
      }
      if (failure === null && unitsIn() < Q) failure = { detail: "SELL_STACK_SHORT", permanent: true };
      if (failure === null) {
        const pr = promoteSellEscrowFrom(s.escrowState, { orderId, offerId: spec.offerId, at: nowMs });
        if (!pr.ok) failure = { detail: pr.reason, permanent: false };
      }
    }

    if (failure !== null) {
      const det = detachEscrowFrom(s.escrowState, { orderId, offerId: spec.offerId, escrowType: "sell" });
      let rollbackFailed = null;
      let rbDetail = "";
      if (det.ok) {
        const cr = await cancelBuyOrderFrom(s.daemon, orderId);
        if (!cr || cr.ok !== true) { rollbackFailed = "CANCEL"; rbDetail = `:cancel:${(cr && cr.reason) || "no_result"}`; }
        const rr = returnSellEscrowFrom(s, { offerId: spec.offerId, orderId, corporationId: corp,
          stationId: spec.stationId, typeId: spec.typeId });
        if (!rr || rr.ok !== true) {
          rollbackFailed = rollbackFailed || "RETURN";
          rbDetail += `:return:${(rr && rr.reason) || "no_result"}`;
        }
      }
      return { ok: false, reason: failure.reason || "MARKET_ESCROW_FAILED", permanent: failure.permanent,
        ambiguous: !det.ok || rollbackFailed !== null,
        ...(rollbackFailed !== null ? { rollbackFailed } : {}),
        detail: det.ok ? `${failure.detail}${rbDetail}` : `${failure.detail}:${det.reason}` };
    }

    if (findRes.found === "daemon" && Array.isArray(findRes.extraOrderIds)) {
      for (const extraId of findRes.extraOrderIds) await cancelBuyOrderFrom(s.daemon, extraId);
    }
    const beyond = Number(escrowLoc) >= escrowLimitOf(s.marketCustody);
    return beyond ? { ok: true, orderId, escrowBeyondLimit: true } : { ok: true, orderId };
  } catch (err) {
    return { ok: false, reason: "MARKET_UNAVAILABLE", permanent: false, ambiguous: true, detail: errorText(err) };
  }
}

function escrowLimitOf(marketCustody) {
  const base = Number(marketCustody && marketCustody.MARKET_ESCROW_LOCATION_BASE);
  return Number.isSafeInteger(base) && base > 0 ? base + 100000000 : Number.MAX_SAFE_INTEGER;
}

function isBuyOrderDurationAllowedFrom(marketRules, days) {
  if (!marketRules || typeof marketRules.isAllowedDuration !== "function") return false;
  if (!Number.isInteger(days) || days < 1) return false;
  try { return marketRules.isAllowedDuration(days) === true; } catch (_err) { return false; }
}

const MARKET_FILL_IMPORT_RE = /const\s*\{[^}]*\bisNpcCorporationID\b[^}]*\}\s*=\s*require\s*\(/;
const MARKET_FILL_RULE_RE =
  /isSeedBuyOrder\s*=\s*isNpcCorporationID\s*\(\s*playerBuyOrder\s*&&\s*playerBuyOrder\s*\.\s*owner_id\s*\)\s*;/;
const MARKET_FILL_RANGE_RE = /numericID\s*>=\s*(\d+)\s*&&\s*numericID\s*<\s*(\d+)\s*;/;
const MARKET_FILL_ESCROW_READ = "getEscrowRecord(buyOrder";
const MARKET_FILL_SEED_BUILD = "buildSeedBuyFillSaga(";
const MARKET_FILL_SEED_EXECUTE = "executeSeedBuyFillSaga(";
const MARKET_FILL_DAEMON_FILL = 'marketDaemonClient.call("FillOrder"';
const MARKET_FILL_CONSUME = "consumeSeedMarketInventoryQuantity(";

function topLevelBodyOf(text, header) {
  const start = text.indexOf(header);
  if (start < 0) return null;
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end < 0 ? text.length : end + 3);
}

function parseMarketFillRule(marketText, corpText) {
  const drift = (detail) => ({ ok: false, reason: "MARKET_FILL_RULE_DRIFT", detail });
  if (typeof marketText !== "string" || !MARKET_FILL_IMPORT_RE.test(marketText)) return drift("import");
  const match = topLevelBodyOf(marketText, "async function matchBuyOrdersForSeller(");
  const rule = match === null ? null : MARKET_FILL_RULE_RE.exec(match);
  const escrowAt = match === null ? -1 : match.indexOf(MARKET_FILL_ESCROW_READ);
  if (rule === null || escrowAt < 0 || rule.index >= escrowAt) return drift("rule");
  if (!match.includes(MARKET_FILL_SEED_BUILD) || !match.includes(MARKET_FILL_SEED_EXECUTE)) return drift("seedPath");
  const saga = topLevelBodyOf(marketText, "async function executeSeedBuyFillSagaUnlocked(");
  const fillAt = saga === null ? -1 : saga.indexOf(MARKET_FILL_DAEMON_FILL);
  const consumeAt = saga === null ? -1 : saga.indexOf(MARKET_FILL_CONSUME);
  if (fillAt < 0 || consumeAt < 0 || fillAt >= consumeAt) return drift("consume");
  const isNpc = typeof corpText === "string" ? topLevelBodyOf(corpText, "function isNpcCorporationID(") : null;
  const range = isNpc === null ? null : MARKET_FILL_RANGE_RE.exec(isNpc);
  const npcCorpMin = range ? Number(range[1]) : NaN;
  const npcCorpMax = range ? Number(range[2]) : NaN;
  if (!Number.isSafeInteger(npcCorpMin) || !Number.isSafeInteger(npcCorpMax) || npcCorpMin < 1
    || npcCorpMax <= npcCorpMin) return drift("range");
  return { ok: true, mode: "VENDOR_VOID", npcCorpMin, npcCorpMax };
}

module.exports = {
  SEED_ORDER_ID_MIN,
  parseMarketFillRule,
  MARKET_FILL_IMPORT_RE,
  MARKET_FILL_RULE_RE,
  MARKET_FILL_RANGE_RE,
  stationMetadataFrom,
  buildBuyOrderCall,
  placeBuyOrderFrom,
  placeAndAttachBuyOrderFrom,
  readBuyOrderFrom,
  findBuyOrderFrom,
  attachBuyEscrowFrom,
  detachBuyEscrowFrom,
  cancelBuyOrderFrom,
  listCorpBuyOrdersFrom,
  listTaggedEscrowsFrom,
  isBuyOrderDurationAllowedFrom,
  ESCROW_STATE_PLACING,
  ESCROW_STATE_ACTIVE,
  openPlayerAskKey,
  buildSellOrderCall,
  findSellOrderFrom,
  attachSellEscrowFrom,
  promoteSellEscrowFrom,
  detachEscrowFrom,
  returnSellEscrowFrom,
  placeAndAttachSellOrderFrom,
  listCorpOrdersFrom,
};
