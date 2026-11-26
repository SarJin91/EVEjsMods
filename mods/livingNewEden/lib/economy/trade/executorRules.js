"use strict";

const S = require("./schema");
const { tierOf, tierTtlOf } = require("../../strategy/data/tradeTiers");
const { MINERALS } = require("../data/mineralYield");
const { UNKNOWN } = require("../../names/fallback");

function closeWanted(offer, station, now, mode) {
  if (mode === "cleanup") return "DISABLED";

  if (!station) return "STATION_GONE";
  if (station.destroyed === true) return "STATION_GONE";
  if (station.kind !== "npc" && station.kind !== "npc_reinforce") return "STATION_GONE";
  if (station.ownerCorporationId !== offer.issuerCorporationId) return "STATION_GONE";

  if (now >= offer.expiresAt) return "EXPIRED";

  return null;
}

function issueGate(offer, station, issuer) {
  if (!station) return "STATION_GONE";
  if (station.kind !== "npc" && station.kind !== "npc_reinforce") return "STATION_GONE";
  if (station.online !== true) return "STATION_GONE";
  if (!Number.isSafeInteger(station.npcStationId) || station.npcStationId <= 0) return "STATION_GONE";
  if (station.ownerCorporationId !== offer.issuerCorporationId) return "STATION_GONE";

  if (!issuer) return "NO_ISSUER";
  if (!issuer.isNpc) return "NO_ISSUER";
  if (!Number.isSafeInteger(issuer.ceoId) || issuer.ceoId <= 0) return "NO_ISSUER";
  if (!issuer.hasRuntime) return "NO_ISSUER";

  return null;
}

function abortAllowed(found, offer, now, issueTimeoutMs, lastPermanent) {
  if (found && (found.found === "record" || found.found === "pending")) return false;
  if (lastPermanent === true) return true;
  return now - offer.updatedAt >= issueTimeoutMs;
}

function contractTtlOf(offer, contractTtlMs, privateOfferTtlMs, tiers = null) {
  const base = tiers && offer && Number.isFinite(offer.iskTotal)
    ? tierTtlOf(tierOf(offer.iskTotal, tiers), tiers) : contractTtlMs;
  const assignee = offer && offer.assigneeCharacterId;
  if (Number.isSafeInteger(assignee) && assignee > 0) {
    const pttl = Number.isFinite(privateOfferTtlMs) && privateOfferTtlMs > 0 ? privateOfferTtlMs : base;
    return Math.min(base, pttl);
  }
  return base;
}

const isPosId = (v) => Number.isSafeInteger(v) && v > 0;

function issuerOf(offer, walletAccountKey) {
  const o = offer || {};
  if (isPosId(o.issuerCharacterId) && isPosId(o.issuerCharacterCorpId)) {
    return {
      kind: S.ISSUER_KIND_CHARACTER, ownerId: o.issuerCharacterId, corporationId: o.issuerCharacterCorpId,
      characterId: o.issuerCharacterId, accountKey: S.CHARACTER_ACCOUNT_KEY,
    };
  }
  return {
    kind: S.ISSUER_KIND_CORPORATION, ownerId: o.issuerCorporationId, corporationId: o.issuerCorporationId,
    characterId: null, accountKey: walletAccountKey,
  };
}

function issuerOfPayload(payload, walletAccountKey) {
  const p = payload || {};
  if (p.issuerKind === S.ISSUER_KIND_CHARACTER) {
    return {
      kind: S.ISSUER_KIND_CHARACTER, ownerId: p.ownerId, corporationId: p.corporationId,
      characterId: p.ownerId, accountKey: S.CHARACTER_ACCOUNT_KEY,
    };
  }
  return {
    kind: S.ISSUER_KIND_CORPORATION, ownerId: p.corporationId, corporationId: p.corporationId,
    characterId: null, accountKey: walletAccountKey,
  };
}

function buildIssuePayload(offer, station, issuer, cfg, factionName) {
  const name = typeof factionName === "string" && factionName.length > 0 ? factionName : UNKNOWN.faction;
  const isPrivate = Number.isSafeInteger(offer.assigneeCharacterId) && offer.assigneeCharacterId > 0;
  const ttlMs = contractTtlOf(offer, cfg.contractTtlMs, cfg.privateOfferTtlMs, cfg.tiers || null);
  const minutesExpire = Math.max(1, Math.ceil(ttlMs / 60000));
  const title = isPrivate ? `${name}: private purchase order`.slice(0, 200) : `${name}: purchase order`.slice(0, 200);
  const tag = `[LNE:${offer.offerId}]`;
  const description = offer.itemKind === S.ITEM_KIND_HULL
    ? `${tag} ${name} buys ${offer.quantity} ships of this type for its station. Deliver packaged ships to this station; modules and cargo inside an assembled ship are consumed with it.`.slice(0, 4000)
    : isPrivate
      ? `${tag} ${name} buys ${offer.quantity} units of this item for its station. Deliver to this station. Offered to a trusted supplier.`.slice(0, 4000)
      : `${tag} ${name} buys ${offer.quantity} units of this item for its station. Deliver to this station.`.slice(0, 4000);

  const iss = issuerOf(offer, cfg.accountKey);
  const isCharacter = iss.kind === S.ISSUER_KIND_CHARACTER;

  const payload = {
    offerId: offer.offerId,
    corporationId: iss.corporationId,
    ceoId: isCharacter ? iss.characterId : issuer.ceoId,
    accountKey: iss.accountKey,
    npcStationId: station.stationId,
    typeId: offer.typeId,
    quantity: offer.quantity,
    rewardIsk: offer.iskTotal,
    minutesExpire,
    title,
    description,
  };
  if (isPrivate) {
    payload.assigneeCharacterId = offer.assigneeCharacterId;
    if (Number.isSafeInteger(cfg.privateBrokerFeeIsk) && cfg.privateBrokerFeeIsk > 0) {
      payload.brokerFeeIsk = cfg.privateBrokerFeeIsk;
    }
  }
  if (isCharacter) {
    payload.issuerKind = S.ISSUER_KIND_CHARACTER;
    payload.ownerId = iss.ownerId;
  }
  return payload;
}

function planIntake(offer, stacks, now, graceMs) {
  const have = stacks.reduce((sum, s) => sum + (Number.isSafeInteger(s.quantity) && s.quantity > 0 ? s.quantity : 0), 0);
  const isMarket = offer.channel === S.CHANNEL_MARKET;
  const target = isMarket && Number.isSafeInteger(offer.filledQuantity) ? offer.filledQuantity
    : (Number.isSafeInteger(offer.quantity) ? offer.quantity : 0);

  if (have >= target) {
    let remaining = target;
    const plan = [];
    for (const s of stacks) {
      if (remaining <= 0) break;
      const take = Math.min(s.quantity, remaining);
      plan.push({ itemId: s.itemId, quantity: take });
      remaining -= take;
    }
    return { action: "PLAN", stacks: plan, short: 0 };
  }

  const elapsed = now - (Number.isSafeInteger(offer.updatedAt) ? offer.updatedAt : now);
  if (elapsed < graceMs) {
    return { action: "WAIT" };
  }

  if (have === 0) {
    return { action: "LOST", reason: "NOTHING_DELIVERED" };
  }

  const plan = stacks.filter((s) => Number.isSafeInteger(s.quantity) && s.quantity > 0).map((s) => ({ itemId: s.itemId, quantity: s.quantity }));
  return { action: "PLAN", stacks: plan, short: target - have };
}

function stationGate(station, issuerCorporationId) {
  if (!station) return "STATION_GONE";
  if (station.destroyed === true) return "STATION_GONE";
  if (station.kind !== "npc" && station.kind !== "npc_reinforce") return "STATION_GONE";
  if (station.ownerCorporationId !== issuerCorporationId) return "STATION_GONE";
  return null;
}

function npcIssuerGate(issuer) {
  if (!issuer) return "NO_ISSUER";
  if (!issuer.isNpc) return "NO_ISSUER";
  if (!Number.isSafeInteger(issuer.ceoId) || issuer.ceoId <= 0) return "NO_ISSUER";
  if (!issuer.hasRuntime) return "NO_ISSUER";
  return null;
}

function pickIssuer(candidates, counts) {
  const arr = candidates.slice();
  arr.sort((a, b) => {
    const ca = counts.get(a.characterId) || 0;
    const cb = counts.get(b.characterId) || 0;
    if (ca !== cb) return ca - cb;
    return a.slot - b.slot;
  });
  return arr;
}

function sellLabelOf(offer, typeName) {
  if (offer.itemKind === S.ITEM_KIND_HULL && typeof offer.itemKey === "string" && offer.itemKey.startsWith("group:")) {
    return `${offer.itemKey.slice("group:".length)} hull`;
  }
  if (offer.itemKind === S.ITEM_KIND_MOON || offer.itemKind === S.ITEM_KIND_PI) {
    return typeof typeName === "string" && typeName.length > 0 ? typeName : UNKNOWN.item;
  }
  const name = MINERALS[offer.typeId];
  return typeof name === "string" ? name : UNKNOWN.item;
}

function buildSellIssuePayload(offer, station, issuer, cfg, factionName, typeName) {
  const name = typeof factionName === "string" && factionName.length > 0 ? factionName : UNKNOWN.faction;
  const minutesExpire = Math.max(1, Math.ceil(cfg.wtsTtlMs / 60000));
  const label = sellLabelOf(offer, typeName);
  const hull = offer.itemKind === S.ITEM_KIND_HULL;
  const tag = `[LNE:${offer.offerId}]`;
  const title = `${name} sells ${offer.quantity} x ${label}`.slice(0, 200);
  const description = (hull
    ? `${tag} ${name} sells ${offer.quantity} packaged ships (${label}) at its station. The ships are in this contract.`
    : `${tag} ${name} sells ${offer.quantity} units of ${label} at its station. The goods are in this contract.`)
    .slice(0, 4000);
  const iss = issuerOf(offer, cfg.accountKey);
  const isCharacter = iss.kind === S.ISSUER_KIND_CHARACTER;
  const payload = {
    offerId: offer.offerId,
    side: S.SIDE_SELL,
    corporationId: iss.corporationId,
    ceoId: isCharacter ? iss.characterId : issuer.ceoId,
    accountKey: iss.accountKey,
    npcStationId: station.stationId,
    typeId: offer.typeId,
    quantity: offer.quantity,
    priceIsk: offer.iskTotal,
    packaged: hull,
    grantKey: S.grantKey(offer.offerId),
    minutesExpire,
    title,
    description,
  };
  if (isCharacter) {
    payload.issuerKind = S.ISSUER_KIND_CHARACTER;
    payload.ownerId = iss.ownerId;
  }
  return payload;
}

function sellGrantGate(offer, stockOutFound) {
  if (!offer || offer.side !== S.SIDE_SELL) return "SELL_NOT_SELL";
  if (stockOutFound !== true) return S.END_REASON_SELL_STOCK_OUT_MISSING;
  return null;
}

function planReturn(quantity, stacks) {
  const valid = (Array.isArray(stacks) ? stacks : [])
    .filter((s) => s && isPosId(s.itemId) && isPosId(s.quantity))
    .slice()
    .sort((a, b) => a.itemId - b.itemId);
  let rest = isPosId(quantity) ? quantity : 0;
  const plan = [];
  for (const s of valid) {
    if (rest <= 0) break;
    const take = Math.min(s.quantity, rest);
    plan.push({ itemId: s.itemId, quantity: take });
    rest -= take;
  }
  return { stacks: plan, planned: plan.reduce((sum, s) => sum + s.quantity, 0) };
}

function planReturnOwnFirst(quantity, stacks, ownItemIds) {
  const own = new Set((Array.isArray(ownItemIds) ? ownItemIds : []).filter(isPosId));
  const all = Array.isArray(stacks) ? stacks : [];
  const first = planReturn(quantity, all.filter((s) => s && own.has(s.itemId)));
  const left = (isPosId(quantity) ? quantity : 0) - first.planned;
  if (left <= 0) return first;
  const rest = planReturn(left, all.filter((s) => s && !own.has(s.itemId)));
  return { stacks: [...first.stacks, ...rest.stacks], planned: first.planned + rest.planned };
}

function fundIskOf(payload) {
  const fee = payload && Number.isSafeInteger(payload.brokerFeeIsk) && payload.brokerFeeIsk > 0 ? payload.brokerFeeIsk : 0;
  return payload.rewardIsk + fee;
}

module.exports = { closeWanted, issueGate, buildIssuePayload, fundIskOf, abortAllowed, planIntake, contractTtlOf, issuerOf, issuerOfPayload, stationGate, npcIssuerGate, pickIssuer,
  buildSellIssuePayload, sellGrantGate, planReturn, planReturnOwnFirst, sellLabelOf };