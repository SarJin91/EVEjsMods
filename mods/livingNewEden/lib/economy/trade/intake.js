"use strict";

const S = require("./schema");
const { planIntake, issuerOf } = require("./executorRules");
const { SCHEMA } = require("../../../config");
const { refineOre } = require("./orePricing");

const STOCK_REFUSED = "STOCK_REFUSED";
const METRIC_ORE_REFINED = "trade.oreRefinedPortions";
const METRIC_ORE_REMAINDER = "trade.oreRemainder";
const METRIC_HULLS_DELIVERED = "trade.hullsDelivered";
const METRIC_MARKET_VENDOR_VOID = "trade.marketVendorVoidIntake";
const METRIC_MARKET_FILL_DRIFT = "trade.marketFillRuleDrift";
const driftSeenBySink = new WeakMap();
function countDriftOnce(telemetry, offerId) {
  if (!telemetry || typeof telemetry !== "object") return;
  let seen = driftSeenBySink.get(telemetry);
  if (!seen) {
    seen = new Set();
    driftSeenBySink.set(telemetry, seen);
  }
  if (seen.has(offerId)) return;
  seen.add(offerId);
  metric(telemetry, METRIC_MARKET_FILL_DRIFT, 1);
}

const schemaDefault = (key) => {
  const row = SCHEMA.find((r) => r.key === key);
  return row ? row.default : undefined;
};
const DEFAULT_STOCK_LIMITS = Object.freeze({
  maxStockQuantity: schemaDefault("stations.maxStockQuantity"),
  maxStockItemsPerStation: schemaDefault("stations.maxStockItemsPerStation"),
  maxDeltasPerChange: schemaDefault("stations.maxDeltasPerChange"),
});
const DEFAULT_ORE_EFFICIENCY = schemaDefault("trade.oreRefineEfficiencyPermille");

const isOreOffer = (offer) => Boolean(offer) && offer.itemKind === S.ITEM_KIND_ORE;
const stockKindOf = (offer) => (offer && (offer.itemKind === S.ITEM_KIND_HULL || offer.itemKind === S.ITEM_KIND_MOON
  || offer.itemKind === S.ITEM_KIND_PI) ? offer.itemKind : S.ITEM_KIND_MINERAL);

function orePlanOf(plan) {
  const ore = plan && plan.ore;
  if (!ore || typeof ore !== "object") return null;
  const { portionSize, efficiencyPermille, minerals } = ore;
  if (!Number.isSafeInteger(portionSize) || portionSize < 1) return null;
  if (!Number.isSafeInteger(efficiencyPermille) || efficiencyPermille < 0 || efficiencyPermille > 1000) return null;
  if (!Array.isArray(minerals) || minerals.length === 0 || !minerals.every((p) => Array.isArray(p) && p.length === 2
    && typeof p[0] === "string" && Number.isSafeInteger(p[1]) && p[1] >= 0)) return null;
  return { portionSize, efficiencyPermille, minerals: minerals.map((p) => [p[0], p[1]]) };
}

async function stepAccepted(deps, offer, station) {
  const { store, journal, offers, adapter, config, clock, telemetry, logger } = deps;
  const tradeCfg = config.trade || {};
  const graceMs = Math.max(0, Math.trunc(tradeCfg.intakeGraceMs || 600000));

  if (!station || station.destroyed === true) {
    await transitionToLost(deps, offer.offerId, "STATION_GONE", "accepted:station_gone");
    metric(telemetry, "trade.lost", 1);
    return { action: "LOST", reason: "STATION_GONE" };
  }

  let oreEntry = null;
  if (isOreOffer(offer)) {
    const entry = deps.catalog && typeof deps.catalog.get === "function" ? deps.catalog.get(offer.itemKey) : null;
    if (!entry || entry.itemKind !== S.ITEM_KIND_ORE || entry.typeId !== offer.typeId) {
      const seen = deps.oreMissSeen instanceof Set ? deps.oreMissSeen : null;
      if (seen !== null && seen.has(offer.offerId)) return { action: "WAIT", reason: "ORE_NOT_IN_CATALOG" };
      if (seen !== null) seen.add(offer.offerId);
      log(logger, `[tradeExecutor] ACCEPTED ${offer.offerId}: ore ${offer.itemKey} not in the trade catalog`);
      metric(telemetry, "trade.seamError", 1);
      return { action: "ERROR", reason: "ORE_NOT_IN_CATALOG" };
    }
    oreEntry = entry;
  }

  const iss = issuerOf(offer, tradeCfg.walletAccountKey);
  const isMarket = offer.channel === S.CHANNEL_MARKET;
  if (isMarket && oreEntry === null) {
    let fm = null;
    try {
      fm = typeof adapter.tradeMarketFillMode === "function" ? adapter.tradeMarketFillMode() : null;
    } catch (_err) {
      fm = null;
    }
    const filled = offer.filledQuantity;
    const fmOk = Boolean(fm) && fm.ok === true && fm.mode === "VENDOR_VOID";
    if (!fmOk) countDriftOnce(telemetry, offer.offerId);
    const vendorVoid = fmOk && Number.isSafeInteger(iss.corporationId)
      && iss.corporationId >= fm.npcCorpMin && iss.corporationId < fm.npcCorpMax
      && Number.isSafeInteger(filled) && filled >= 1 && filled <= offer.quantity;
    if (vendorVoid) return acceptVendorVoid(deps, offer, station, iss, filled);
  }
  const stacksRes = await adapter.tradeListDeliveredStacks({
    ownerKind: iss.kind,
    ownerId: iss.ownerId,
    npcStationId: station.stationId,
    typeId: offer.typeId,
    flag: isMarket ? 4 : undefined,
  });
  if (!stacksRes.ok) {
    log(logger, `[tradeExecutor] tradeListDeliveredStacks failed for ${offer.offerId}: ${stacksRes.reason}`);
    metric(telemetry, "trade.seamError", 1);
    return { action: "ERROR", reason: stacksRes.reason };
  }

  const stacks = stacksRes.stacks || [];
  const now = clock.now();
  const plan = planIntake(offer, stacks, now, graceMs);

  if (plan.action === "WAIT") {
    return { action: "WAIT" };
  }

  if (plan.action === "LOST") {
    await transitionToLost(deps, offer.offerId, plan.reason, "accepted:nothing_delivered");
    metric(telemetry, "trade.lost", 1);
    return { action: "LOST", reason: plan.reason };
  }

  const intakeKey = S.intakeOutboxKey(offer.offerId);
  const payload = {
    offerId: offer.offerId,
    npcStationId: station.stationId,
    corporationId: iss.corporationId,
    ownerKind: iss.kind,
    ownerId: iss.ownerId,
    typeId: offer.typeId,
    stacks: plan.stacks,
  };
  if (isMarket) payload.flag = 4;
  if (oreEntry !== null) {
    const eff = tradeCfg.oreRefineEfficiencyPermille;
    payload.ore = {
      portionSize: oreEntry.portionSize,
      efficiencyPermille: Number.isSafeInteger(eff) ? eff : DEFAULT_ORE_EFFICIENCY,
      minerals: oreEntry.minerals.map((p) => [p[0], p[1]]),
    };
  }

  const txRes = store.transaction("trade.accepted_intake", (db) => {
    const transRes = offers.transitionOfferInTx(db, {
      offerId: offer.offerId,
      expectedVersion: offer.version,
      from: S.ACCEPTED,
      to: S.INTAKE,
      reason: "",
      at: now,
    }, S.transitionKey(offer.offerId, offer.stateSeq + 1, S.INTAKE));
    if (!transRes.ok) return transRes;

    const outboxRes = journal.enqueueOutbox(db, {
      key: intakeKey,
      aggregate: { type: S.OFFER_AGGREGATE, id: offer.offerId },
      eventType: S.EVENT_OUTBOX_INTAKE,
      payload,
    });
    if (!outboxRes.ok) return outboxRes;

    return { ok: true, offer: transRes.offer };
  });

  if (!txRes.ok || !txRes.value?.ok) {
    log(logger, `[tradeExecutor] ACCEPTED→INTAKE failed: ${txRes.value?.reason || txRes.reason}`);
    metric(telemetry, "trade.seamError", 1);
    return { action: "ERROR", reason: txRes.value?.reason || txRes.reason };
  }

  if (plan.short > 0) {
    metric(telemetry, "trade.intakeShort", 1);
  }

  return { action: "PLAN", plan, short: plan.short };
}

function acceptVendorVoid(deps, offer, station, iss, filled) {
  const { store, journal, offers, clock, telemetry, logger } = deps;
  const now = clock.now();
  const payload = {
    offerId: offer.offerId,
    npcStationId: station.stationId,
    corporationId: iss.corporationId,
    ownerKind: iss.kind,
    ownerId: iss.ownerId,
    typeId: offer.typeId,
    stacks: [],
    flag: 4,
    vendorVoid: { quantity: filled },
  };
  const txRes = store.transaction("trade.accepted_intake", (db) => {
    const transRes = offers.transitionOfferInTx(db, {
      offerId: offer.offerId,
      expectedVersion: offer.version,
      from: S.ACCEPTED,
      to: S.INTAKE,
      reason: "",
      at: now,
    }, S.transitionKey(offer.offerId, offer.stateSeq + 1, S.INTAKE));
    if (!transRes.ok) return transRes;
    const outboxRes = journal.enqueueOutbox(db, {
      key: S.intakeOutboxKey(offer.offerId),
      aggregate: { type: S.OFFER_AGGREGATE, id: offer.offerId },
      eventType: S.EVENT_OUTBOX_INTAKE,
      payload,
    });
    if (!outboxRes.ok) return outboxRes;
    return { ok: true, offer: transRes.offer };
  });
  if (!txRes.ok || !txRes.value?.ok) {
    log(logger, `[tradeExecutor] ACCEPTED→INTAKE failed: ${txRes.value?.reason || txRes.reason}`);
    metric(telemetry, "trade.seamError", 1);
    return { action: "ERROR", reason: txRes.value?.reason || txRes.reason };
  }
  return { action: "PLAN", plan: { action: "PLAN", stacks: [], short: 0 }, short: 0, vendorVoid: true };
}

async function stepIntake(deps, offer) {
  const { store, journal, offers, adapter, config, clock, telemetry, logger } = deps;
  const tradeCfg = config.trade || {};

  const intakeKey = S.intakeOutboxKey(offer.offerId);
  const outboxRes = store.transaction("trade.intake.read_outbox", (db) => {
    return journal.findByKey(db, intakeKey);
  });
  if (!outboxRes.ok || !outboxRes.value?.found) {
    log(logger, `[tradeExecutor] INTAKE outbox missing for ${offer.offerId}`);
    metric(telemetry, "trade.seamError", 1);
    return { action: "ERROR", reason: "NO_OUTBOX" };
  }
  const plan = outboxRes.value.entry.payload;
  const now = clock.now();
  const limits = stockLimitsOf(config);
  const isOre = isOreOffer(offer) || (plan && plan.ore !== undefined);
  const orePlan = isOre ? orePlanOf(plan) : null;
  if (isOre && orePlan === null) {
    log(logger, `[tradeExecutor] INTAKE ${offer.offerId}: ore plan missing`);
    metric(telemetry, "trade.seamError", 1);
    return { action: "ERROR", reason: "ORE_PLAN_MISSING" };
  }
  const vv = plan && plan.vendorVoid !== undefined ? plan.vendorVoid : null;
  if (vv !== null && (!vv || !Number.isSafeInteger(vv.quantity) || vv.quantity < 1)) {
    log(logger, `[tradeExecutor] INTAKE ${offer.offerId}: vendor-void plan invalid`);
    metric(telemetry, "trade.seamError", 1);
    return { action: "ERROR", reason: "VENDOR_VOID_PLAN_INVALID" };
  }

  const pre = store.transaction("trade.intake.precheck", (db) => {
    const curRes = offers.getOffer(db, offer.offerId);
    if (!curRes || curRes.ok !== true) throw new IntakeRollback(curRes || { ok: false, reason: "OFFER_READ_FAILED" });
    const current = curRes.offer;
    if (!current || current.state !== S.INTAKE) return { outcome: "STALE" };
    const stationRow = getStationRow(db, plan.npcStationId);
    if (!stationRow || stationRow.state === "DESTROYED") return { outcome: "GO" };
    const itemCount = db.prepare("SELECT COUNT(*) AS n FROM world_station_stock WHERE station_id = ?")
      .get(stationRow.station_id).n;
    let detail = null;
    if (orePlan !== null) {
      detail = orePrecheck(db, stationRow.station_id, orePlan, plan.stacks, itemCount, limits);
    } else {
      const stockItem = getStockItem(db, stationRow.station_id, stockKindOf(offer), offer.itemKey);
      const have = stockItem ? stockItem.quantity : 0;
      const noHeadroom = limits.maxStockQuantity - have <= 0;
      const noSlot = !stockItem && itemCount + 1 > limits.maxStockItemsPerStation;
      if (noHeadroom) detail = "STOCK_CAP";
      else if (noSlot) detail = "STOCK_ITEMS_LIMIT";
    }
    if (detail === null) return { outcome: "GO" };
    const markRes = journal.markApplied(db, outboxRes.value.entry.journalId);
    if (!markRes.ok) throw new IntakeRollback(markRes);
    const trRes = offers.transitionOfferInTx(db, {
      offerId: current.offerId, expectedVersion: current.version, from: S.INTAKE, to: S.LOST,
      reason: STOCK_REFUSED, at: now,
    }, S.transitionKey(current.offerId, current.stateSeq + 1, S.LOST));
    if (!trRes || !trRes.ok) throw new IntakeRollback(trRes || { ok: false, reason: "TRANSITION_FAILED" });
    return { outcome: "LOST", detail };
  });
  if (!pre.ok) {
    const refusal = pre.error instanceof IntakeRollback ? pre.error.refusal : null;
    const reason = (refusal && refusal.reason) || pre.reason;
    log(logger, `[tradeExecutor] INTAKE pre-check failed for ${offer.offerId}: ${reason}`);
    metric(telemetry, "trade.seamError", 1);
    return { action: "ERROR", reason };
  }
  if (pre.value.outcome === "STALE") return { action: "STALE" };
  if (pre.value.outcome === "LOST") {
    log(logger, `[tradeExecutor] INTAKE ${offer.offerId}: stock refused before void (${pre.value.detail}) - LOST`);
    metric(telemetry, "trade.intakeRefused", 1);
    metric(telemetry, "trade.lost", 1);
    return { action: "LOST", reason: STOCK_REFUSED };
  }

  const planCharacter = plan.ownerKind === S.ISSUER_KIND_CHARACTER;
  const ownerKind = planCharacter ? S.ISSUER_KIND_CHARACTER : S.ISSUER_KIND_CORPORATION;
  const ownerId = planCharacter ? plan.ownerId : plan.corporationId;
  const voidFlag = plan.flag;
  let voided = vv !== null ? vv.quantity : 0;
  for (const stack of vv !== null ? [] : plan.stacks) {
    const voidKey = S.voidKey(offer.offerId, stack.itemId);
    const voidRes = await adapter.tradeVoidStack({
      ownerKind,
      ownerId,
      npcStationId: plan.npcStationId,
      itemId: stack.itemId,
      quantity: stack.quantity,
      key: voidKey,
      flag: voidFlag,
    });

    if (!voidRes.ok) {
      if (voidRes.reason === "ITEM_MISSING" && voidRes.permanent === true) {
        continue;
      }
      if (voidRes.ambiguous === true || voidRes.permanent === false) {
        return { action: "RETRY", reason: voidRes.reason };
      }
      log(logger, `[tradeExecutor] voidStack failed for ${offer.offerId} item ${stack.itemId}: ${voidRes.reason}`);
      metric(telemetry, "trade.seamError", 1);
      return { action: "ERROR", reason: voidRes.reason };
    }

    if (voidRes.outcome === "VOIDED" || voidRes.outcome === "DUPLICATE" || voidRes.outcome === "ALREADY_COMMITTED") {
      voided += stack.quantity;
    }
  }

  const txRes = store.transaction("trade.intake.deliver", (db) => {
    const curRes = offers.getOffer(db, offer.offerId);
    if (!curRes || curRes.ok !== true) throw new IntakeRollback(curRes || { ok: false, reason: "OFFER_READ_FAILED" });
    const current = curRes.offer;
    if (!current || current.state !== S.INTAKE) return { outcome: "STALE" };

    const settle = (to, reason, patch) => {
      const markRes = journal.markApplied(db, outboxRes.value.entry.journalId);
      if (!markRes.ok) throw new IntakeRollback(markRes);
      const trRes = offers.transitionOfferInTx(db, {
        offerId: current.offerId,
        expectedVersion: current.version,
        from: S.INTAKE,
        to,
        reason,
        at: now,
        ...(patch ? { patch } : {}),
      }, S.transitionKey(current.offerId, current.stateSeq + 1, to));
      if (!trRes || !trRes.ok) throw new IntakeRollback(trRes || { ok: false, reason: "TRANSITION_FAILED" });
    };

    const stationRow = getStationRow(db, plan.npcStationId);
    if (!stationRow || stationRow.state === "DESTROYED") {
      settle(S.LOST, "STATION_GONE");
      return { outcome: "LOST", reason: "STATION_GONE" };
    }
    if (voided === 0) {
      settle(S.LOST, "NOTHING_DELIVERED");
      return { outcome: "LOST", reason: "NOTHING_DELIVERED" };
    }

    if (orePlan !== null) {
      const headroom = new Map();
      for (const [itemKey] of orePlan.minerals) {
        const row = getStockItem(db, stationRow.station_id, "mineral", itemKey);
        headroom.set(itemKey, Math.max(0, limits.maxStockQuantity - (row ? row.quantity : 0)));
      }
      const r = refineOre({ voided, portionSize: orePlan.portionSize, efficiencyPermille: orePlan.efficiencyPermille,
        minerals: orePlan.minerals, headroom });
      if (!r.ok || r.portions === 0 || r.deltas.length === 0) {
        settle(S.LOST, STOCK_REFUSED);
        const detail = !r.ok ? `${r.reason}:${r.detail}` : (voided < orePlan.portionSize ? "ORE_BELOW_PORTION" : "STOCK_CAP");
        return { outcome: "LOST", reason: STOCK_REFUSED, detail };
      }
      const oreStock = applyStockChangeInTx(db, {
        stationId: stationRow.station_id,
        at: now,
        deltas: r.deltas.map((d) => ({ itemKind: "mineral", itemKey: d.itemKey, delta: d.delta })),
      }, limits);
      if (!oreStock.ok) {
        settle(S.LOST, STOCK_REFUSED);
        return { outcome: "LOST", reason: STOCK_REFUSED, detail: oreStock.reason };
      }
      const oreQ = r.portions * orePlan.portionSize;
      settle(S.DELIVERED, "DELIVERED", { deliveredQuantity: oreQ });
      return { outcome: "DELIVERED", q: oreQ, ore: { portions: r.portions, remainder: r.remainder, cut: r.cut } };
    }

    const internalStationId = stationRow.station_id;
    const stockKind = stockKindOf(offer);
    const stockItem = getStockItem(db, internalStationId, stockKind, offer.itemKey);
    const currentStock = stockItem ? stockItem.quantity : 0;
    const q = Math.min(voided, Math.max(0, limits.maxStockQuantity - currentStock));
    if (q <= 0) {
      settle(S.LOST, STOCK_REFUSED);
      return { outcome: "LOST", reason: STOCK_REFUSED };
    }
    const stockRes = applyStockChangeInTx(db, {
      stationId: internalStationId,
      at: now,
      deltas: [{ itemKind: stockKind, itemKey: offer.itemKey, delta: q }],
    }, limits);
    if (!stockRes.ok) {
      settle(S.LOST, STOCK_REFUSED);
      return { outcome: "LOST", reason: STOCK_REFUSED, detail: stockRes.reason };
    }
    settle(S.DELIVERED, "DELIVERED", { deliveredQuantity: q });
    return { outcome: "DELIVERED", q };
  });

  if (!txRes.ok) {
    const refusal = txRes.error instanceof IntakeRollback ? txRes.error.refusal : null;
    const reason = (refusal && refusal.reason) || txRes.reason;
    log(logger, `[tradeExecutor] INTAKE delivery failed for ${offer.offerId}: ${reason}`);
    metric(telemetry, "trade.seamError", 1);
    return { action: "ERROR", reason };
  }

  const out = txRes.value;
  if (out.outcome === "STALE") return { action: "STALE" };
  if (out.outcome === "LOST") {
    if (out.reason === STOCK_REFUSED) {
      log(logger, `[tradeExecutor] INTAKE ${offer.offerId}: stock refused (${out.detail || "no headroom"}) - LOST`);
      metric(telemetry, "trade.intakeRefused", 1);
    }
    metric(telemetry, "trade.lost", 1);
    return { action: "LOST", reason: out.reason };
  }
  const q = out.q;
  metric(telemetry, "trade.delivered", 1);
  metric(telemetry, "trade.deliveredUnits", q);
  if (vv !== null) metric(telemetry, METRIC_MARKET_VENDOR_VOID, 1);
  if (stockKindOf(offer) === S.ITEM_KIND_HULL) metric(telemetry, METRIC_HULLS_DELIVERED, q);
  if (out.ore) {
    metric(telemetry, METRIC_ORE_REFINED, out.ore.portions);
    if (out.ore.remainder > 0) metric(telemetry, METRIC_ORE_REMAINDER, out.ore.remainder);
    if (out.ore.cut || q + out.ore.remainder < voided) {
      metric(telemetry, "trade.intakeShort", 1);
      return { action: "DELIVERED", deliveredQuantity: q, short: true, ore: out.ore };
    }
    return { action: "DELIVERED", deliveredQuantity: q, ore: out.ore };
  }
  if (q < voided) {
    metric(telemetry, "trade.intakeShort", 1);
    return { action: "DELIVERED", deliveredQuantity: q, short: true };
  }
  return { action: "DELIVERED", deliveredQuantity: q };
}

class IntakeRollback extends Error {
  constructor(refusal) {
    super(String((refusal && refusal.reason) || "INTAKE_ROLLBACK"));
    this.refusal = refusal;
  }
}

function stockLimitsOf(config) {
  const sc = (config && config.stations) || {};
  return {
    maxStockQuantity: sc.maxStockQuantity ?? DEFAULT_STOCK_LIMITS.maxStockQuantity,
    maxStockItemsPerStation: sc.maxStockItemsPerStation ?? DEFAULT_STOCK_LIMITS.maxStockItemsPerStation,
    maxDeltasPerChange: sc.maxDeltasPerChange ?? DEFAULT_STOCK_LIMITS.maxDeltasPerChange,
  };
}

async function transitionToLost(deps, offerId, reason, context) {
  const { store, journal, offers, clock } = deps;
  const now = clock.now();
  
  const currentOffer = store.transaction("trade.lost.read_offer", (db) => {
    return offers.getOffer(db, offerId);
  });
  if (!currentOffer.ok || !currentOffer.value?.offer) {
    log(deps.logger, `[tradeExecutor] LOST transition failed: offer ${offerId} not found`);
    return;
  }
  const current = currentOffer.value.offer;
  
  const txRes = store.transaction(`trade.lost_${context}`, (db) => {
    return offers.transitionOfferInTx(db, {
      offerId: offerId,
      expectedVersion: current.version,
      from: current.state,
      to: S.LOST,
      reason,
      at: now,
    }, S.transitionKey(offerId, current.stateSeq + 1, S.LOST));
  });
  if (!txRes.ok || !txRes.value.ok) {
    log(deps.logger, `[tradeExecutor] LOST transition failed: ${txRes.value?.reason || txRes.reason}`);
  }
}

function orePrecheck(db, stationId, orePlan, stacks, itemCount, limits) {
  const sumStacks = (Array.isArray(stacks) ? stacks : [])
    .reduce((acc, s) => acc + (s && Number.isSafeInteger(s.quantity) && s.quantity > 0 ? s.quantity : 0), 0);
  if (sumStacks < orePlan.portionSize) return "ORE_BELOW_PORTION";
  const headroom = new Map();
  const rows = new Map();
  for (const [itemKey] of orePlan.minerals) {
    const row = getStockItem(db, stationId, "mineral", itemKey);
    rows.set(itemKey, row);
    headroom.set(itemKey, Math.max(0, limits.maxStockQuantity - (row ? row.quantity : 0)));
  }
  const r = refineOre({ voided: sumStacks, portionSize: orePlan.portionSize,
    efficiencyPermille: orePlan.efficiencyPermille, minerals: orePlan.minerals, headroom });
  if (!r.ok) return `${r.reason}:${r.detail}`;
  if (r.portions === 0 || r.deltas.length === 0) return "STOCK_CAP";
  if (r.deltas.length > limits.maxDeltasPerChange) return "STOCK_DELTAS_LIMIT";
  let newKeys = 0;
  for (const d of r.deltas) if (!rows.get(d.itemKey)) newKeys += 1;
  if (itemCount + newKeys > limits.maxStockItemsPerStation) return "STOCK_ITEMS_LIMIT";
  return null;
}

function getStationRow(db, npcStationId) {
  const stmt = db.prepare("SELECT * FROM world_stations WHERE npc_station_id = ?");
  return stmt.get(npcStationId);
}

function getStockItem(db, stationId, itemKind, itemKey) {
  const stmt = db.prepare("SELECT * FROM world_station_stock WHERE station_id = ? AND item_kind = ? AND item_key = ?");
  return stmt.get(stationId, itemKind, itemKey);
}

function applyStockChangeInTx(db, change, L) {
  const deltas = change.deltas;
  const at = change.at;
  if (!Array.isArray(deltas) || deltas.length === 0 || deltas.length > L.maxDeltasPerChange) {
    return { ok: false, reason: "INVALID_INPUT", detail: "deltas" };
  }

  for (const d of deltas) {
    if (!Number.isSafeInteger(d.delta) || d.delta === 0 || Math.abs(d.delta) > L.maxStockQuantity) {
      return { ok: false, reason: "INVALID_INPUT", detail: "delta" };
    }
  }

  const stockStmt = db.prepare("SELECT * FROM world_station_stock WHERE station_id = ? AND item_kind = ? AND item_key = ?");
  const updateStmt = db.prepare("UPDATE world_station_stock SET quantity = ?, updated_at = ? WHERE station_id = ? AND item_kind = ? AND item_key = ?");
  const insertStmt = db.prepare("INSERT INTO world_station_stock (station_id, item_kind, item_key, quantity, updated_at) VALUES (?, ?, ?, ?, ?)");
  const deleteStmt = db.prepare("DELETE FROM world_station_stock WHERE station_id = ? AND item_kind = ? AND item_key = ?");
  const stationUpdateStmt = db.prepare("UPDATE world_stations SET updated_at = ?, version = version + 1 WHERE station_id = ?");

  let itemCountStmt = db.prepare("SELECT COUNT(*) AS n FROM world_station_stock WHERE station_id = ?");
  let itemCount = itemCountStmt.get(change.stationId).n;

  for (const d of deltas) {
    const cur = stockStmt.get(change.stationId, d.itemKind, d.itemKey);
    const have = cur ? cur.quantity : 0;
    const next = have + d.delta;
    if (next < 0) {
      return { ok: false, reason: "INSUFFICIENT_STOCK", itemKind: d.itemKind, itemKey: d.itemKey, have, need: -d.delta };
    }
    if (next > L.maxStockQuantity) {
      return { ok: false, reason: "STOCK_CAP", itemKind: d.itemKind, itemKey: d.itemKey, limit: L.maxStockQuantity };
    }
    if (!cur && next > 0) itemCount += 1;
    if (cur && next === 0) itemCount -= 1;
    if (itemCount > L.maxStockItemsPerStation) {
      return { ok: false, reason: "STOCK_ITEMS_LIMIT", limit: L.maxStockItemsPerStation };
    }
  }

  const atBind = at;
  for (const d of deltas) {
    const cur = stockStmt.get(change.stationId, d.itemKind, d.itemKey);
    const next = (cur ? cur.quantity : 0) + d.delta;
    if (next === 0) {
      deleteStmt.run(change.stationId, d.itemKind, d.itemKey);
    } else if (cur) {
      updateStmt.run(next, atBind, change.stationId, d.itemKind, d.itemKey);
    } else {
      insertStmt.run(change.stationId, d.itemKind, d.itemKey, next, atBind);
    }
  }
  stationUpdateStmt.run(atBind, change.stationId);

  return { ok: true };
}

function metric(telemetry, name, value) {
  if (!telemetry || typeof telemetry.count !== "function") return;
  try { telemetry.count(name, value); } catch (_err) {}
}

function log(logger, ...args) {
  if (logger && typeof logger.log === "function") logger.log(...args);
}

module.exports = { stepAccepted, stepIntake };