"use strict";

const PULSE_EVENT = "EXTRACTION_PULSE";
const PULSE_AGGREGATE_ID = "extraction";
const MARKER_EVENT = "EXTRACTION_CYCLE";
const MARKER_AGGREGATE_TYPE = "extraction";
const DELIVERY_REASON = "EXTRACTION";
const KIND_MOON = "moon";
const KIND_PI = "pi";
const PULSE_FIXED_ROWS = 2;
const STOCK_FIXED_ROWS = 2;
const MARKER_ROWS = 1;
const PLANET_TYPES_PER_CALL = 16;
const LOSS_REASONS = Object.freeze(["STOCK_CAP", "STOCK_ITEMS_LIMIT", "STATION_DESTROYED"]);
const FUEL_REASON = "EXTRACTION_FUEL";
const CONVERSION_REASON = "EXTRACTION_CONVERSION";
const DEMAND_SOFT_REASONS = Object.freeze(["INSUFFICIENT_STOCK", "STOCK_CAP", "STOCK_ITEMS_LIMIT",
  "STATION_DESTROYED"]);
const TRANSFER_REASON = "EXTRACTION_TRANSFER";

const pulseKey = (intervalMs, n) => `extraction:pulse:${intervalMs}:${n}`;
const markerKey = (factionId, bucket) => `extract:${factionId}:${bucket}`;
const deliveryKey = (factionId, bucket, stationId, chunk) => (chunk > 0
  ? `extract:${factionId}:${bucket}:${stationId}:${chunk}` : `extract:${factionId}:${bucket}:${stationId}`);
const fuelKey = (stationId, bucket) => `fuel:${stationId}:${bucket}`;
const conversionKey = (stationId, bucket, outputTypeId) => `pic:${stationId}:${bucket}:${outputTypeId}`;
const transferKey = (src, dst, bucket, side) => `xfer:${src}:${dst}:${bucket}:${side}`;

function factionRowBound(chunks) {
  let rows = MARKER_ROWS;
  for (const n of chunks) rows += n + STOCK_FIXED_ROWS;
  return rows;
}

function demandRowBound(p) {
  return p.conversions * (p.maxSchematicDeltas + STOCK_FIXED_ROWS) + p.fuelStations * (p.fuelTypes + STOCK_FIXED_ROWS);
}

function transferRowBound({ pairs, types }) {
  return pairs * 2 * (types + STOCK_FIXED_ROWS);
}

module.exports = { PULSE_EVENT, PULSE_AGGREGATE_ID, MARKER_EVENT, MARKER_AGGREGATE_TYPE, DELIVERY_REASON, KIND_MOON,
  KIND_PI, PULSE_FIXED_ROWS, STOCK_FIXED_ROWS, MARKER_ROWS, PLANET_TYPES_PER_CALL, LOSS_REASONS, FUEL_REASON,
  CONVERSION_REASON, DEMAND_SOFT_REASONS, TRANSFER_REASON, pulseKey, markerKey, deliveryKey, fuelKey, conversionKey,
  transferKey, factionRowBound, demandRowBound, transferRowBound };
