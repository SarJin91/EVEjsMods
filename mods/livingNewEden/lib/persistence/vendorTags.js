"use strict";

const ESCROW_TABLE = "lne_market_escrow_tags";
const WRECK_TABLE = "lne_native_wreck_tags";
const MAX_OWNER_ID = 128;
const DELETE_CHUNK = 500;
const ORDER_ID_RE = /^[1-9][0-9]{0,19}$/;

const TAG_STORE_METHODS = Object.freeze(["getEscrowTag", "listEscrowTags", "putEscrowTag", "deleteEscrowTags",
  "getWreckTag", "listWreckTags", "putWreckTag", "deleteWreckTags"]);

function upVendorTags(db) {
  db.exec(`
    CREATE TABLE ${ESCROW_TABLE} (
      order_id   TEXT    PRIMARY KEY NOT NULL
                 CHECK (length(order_id) BETWEEN 1 AND 20 AND order_id NOT GLOB '*[^0-9]*' AND substr(order_id, 1, 1) <> '0'),
      offer_id   TEXT    NOT NULL CHECK (length(offer_id) BETWEEN 1 AND ${MAX_OWNER_ID}),
      created_at INTEGER NOT NULL CHECK (created_at >= 0)
    );
    CREATE INDEX ${ESCROW_TABLE}_offer ON ${ESCROW_TABLE} (offer_id);

    CREATE TABLE ${WRECK_TABLE} (
      wreck_id   INTEGER PRIMARY KEY NOT NULL CHECK (wreck_id > 0),
      anomaly_id TEXT    NOT NULL CHECK (length(anomaly_id) BETWEEN 1 AND ${MAX_OWNER_ID}),
      slot       INTEGER NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0)
    );
    CREATE INDEX ${WRECK_TABLE}_anomaly ON ${WRECK_TABLE} (anomaly_id, slot);
  `);
}

function isOrderId(value) {
  return typeof value === "string" && ORDER_ID_RE.test(value);
}

function isOwnerId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_OWNER_ID;
}

function isWreckId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isAt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function slotOf(value) {
  return Number.isSafeInteger(value) ? value : -1;
}

function escrowTagOf(row) {
  return row ? { orderId: String(row.order_id), offerId: String(row.offer_id), createdAt: Number(row.created_at) } : null;
}

function wreckTagOf(row) {
  return row ? { wreckId: Number(row.wreck_id), anomalyId: String(row.anomaly_id), slot: Number(row.slot),
    createdAt: Number(row.created_at) } : null;
}

function invalid(what) {
  return new RangeError(`vendor tag: invalid ${what}`);
}

function getEscrowTagInTx(tx, orderId) {
  if (!isOrderId(orderId)) return null;
  return escrowTagOf(tx.prepare(`SELECT order_id, offer_id, created_at FROM ${ESCROW_TABLE} WHERE order_id = ?`)
    .get(orderId));
}

function listEscrowTagsInTx(tx) {
  return tx.prepare(`SELECT order_id, offer_id, created_at FROM ${ESCROW_TABLE} ORDER BY length(order_id), order_id`)
    .all().map(escrowTagOf);
}

function putEscrowTagInTx(tx, { orderId, offerId, at } = {}) {
  if (!isOrderId(orderId)) throw invalid("orderId");
  if (!isOwnerId(offerId)) throw invalid("offerId");
  if (!isAt(at)) throw invalid("at");
  const existing = getEscrowTagInTx(tx, orderId);
  if (existing) return { outcome: existing.offerId === offerId ? "PRESENT" : "CONFLICT", tag: existing };
  tx.prepare(`INSERT INTO ${ESCROW_TABLE} (order_id, offer_id, created_at) VALUES (?, ?, ?)`).run(orderId, offerId, at);
  return { outcome: "WRITTEN", tag: { orderId, offerId, createdAt: at } };
}

function deleteInChunks(tx, table, column, ids) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    const marks = chunk.map(() => "?").join(", ");
    deleted += tx.prepare(`DELETE FROM ${table} WHERE ${column} IN (${marks})`).run(...chunk).changes;
  }
  return deleted;
}

function deleteEscrowTagsInTx(tx, orderIds) {
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).filter(isOrderId))];
  return ids.length === 0 ? 0 : deleteInChunks(tx, ESCROW_TABLE, "order_id", ids);
}

function getWreckTagInTx(tx, wreckId) {
  if (!isWreckId(wreckId)) return null;
  return wreckTagOf(tx.prepare(`SELECT wreck_id, anomaly_id, slot, created_at FROM ${WRECK_TABLE} WHERE wreck_id = ?`)
    .get(wreckId));
}

function listWreckTagsInTx(tx) {
  return tx.prepare(`SELECT wreck_id, anomaly_id, slot, created_at FROM ${WRECK_TABLE} ORDER BY wreck_id`)
    .all().map(wreckTagOf);
}

function putWreckTagInTx(tx, { wreckId, anomalyId, slot, at } = {}) {
  if (!isWreckId(wreckId)) throw invalid("wreckId");
  if (!isOwnerId(anomalyId)) throw invalid("anomalyId");
  if (!isAt(at)) throw invalid("at");
  const s = slotOf(slot);
  const existing = getWreckTagInTx(tx, wreckId);
  if (existing) {
    const same = existing.anomalyId === anomalyId && existing.slot === s;
    return { outcome: same ? "PRESENT" : "CONFLICT", tag: existing };
  }
  tx.prepare(`INSERT INTO ${WRECK_TABLE} (wreck_id, anomaly_id, slot, created_at) VALUES (?, ?, ?, ?)`)
    .run(wreckId, anomalyId, s, at);
  return { outcome: "WRITTEN", tag: { wreckId, anomalyId, slot: s, createdAt: at } };
}

function deleteWreckTagsInTx(tx, wreckIds) {
  const ids = [...new Set((Array.isArray(wreckIds) ? wreckIds : []).filter(isWreckId))];
  return ids.length === 0 ? 0 : deleteInChunks(tx, WRECK_TABLE, "wreck_id", ids);
}

function importTagsInTx(tx, { escrows, wrecks, at } = {}) {
  if (!isAt(at)) throw invalid("at");
  const out = { inserted: 0, present: 0, conflicts: 0 };
  const count = (outcome) => {
    if (outcome === "WRITTEN") out.inserted += 1;
    else if (outcome === "PRESENT") out.present += 1;
    else out.conflicts += 1;
  };
  for (const e of Array.isArray(escrows) ? escrows : []) {
    count(putEscrowTagInTx(tx, { orderId: e.orderId, offerId: e.offerId, at: isAt(e.createdAt) ? e.createdAt : at })
      .outcome);
  }
  for (const w of Array.isArray(wrecks) ? wrecks : []) {
    count(putWreckTagInTx(tx, { wreckId: w.wreckId, anomalyId: w.anomalyId, slot: w.slot,
      at: isAt(w.createdAt) ? w.createdAt : at }).outcome);
  }
  return out;
}

function createVendorTagStore(store, opts = {}) {
  const legacyRead = opts.legacyRead !== false;
  const pruneMax = Number.isSafeInteger(opts.pruneMax) && opts.pruneMax > 0 ? opts.pruneMax : 0;
  const pruneGraceMs = Number.isSafeInteger(opts.pruneGraceMs) && opts.pruneGraceMs >= 0
    ? opts.pruneGraceMs : Number.POSITIVE_INFINITY;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  const run = (name, fn, shape) => {
    try {
      if (!store || typeof store.transaction !== "function") return { ok: false, reason: "STORE_UNAVAILABLE" };
      const r = store.transaction(name, fn);
      if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
      return { ok: true, ...shape(r.value) };
    } catch (err) {
      return { ok: false, reason: "TX_FAILED", detail: String((err && err.message) || err).slice(0, 120) };
    }
  };
  const put = (name, valid, fn) => {
    if (!valid) return { ok: false, reason: "TAG_INVALID" };
    const r = run(name, fn, (v) => ({ outcome: v.outcome, tag: v.tag }));
    if (r.ok && r.outcome === "CONFLICT") return { ok: false, reason: "TAG_CONFLICT", tag: r.tag };
    return r;
  };

  return Object.freeze({
    legacyRead,
    pruneMax,
    pruneGraceMs,
    now,
    getEscrowTag: (orderId) => run("vendorTags.escrowGet", (tx) => getEscrowTagInTx(tx, orderId), (tag) => ({ tag })),
    listEscrowTags: () => run("vendorTags.escrowList", (tx) => listEscrowTagsInTx(tx), (tags) => ({ tags })),
    putEscrowTag: (spec) => {
      const s = spec || {};
      return put("vendorTags.escrowPut", isOrderId(s.orderId) && isOwnerId(s.offerId) && isAt(s.at),
        (tx) => putEscrowTagInTx(tx, s));
    },
    deleteEscrowTags: (ids) => run("vendorTags.escrowDelete", (tx) => deleteEscrowTagsInTx(tx, ids),
      (deleted) => ({ deleted })),
    getWreckTag: (wreckId) => run("vendorTags.wreckGet", (tx) => getWreckTagInTx(tx, wreckId), (tag) => ({ tag })),
    listWreckTags: () => run("vendorTags.wreckList", (tx) => listWreckTagsInTx(tx), (tags) => ({ tags })),
    putWreckTag: (spec) => {
      const s = spec || {};
      return put("vendorTags.wreckPut", isWreckId(s.wreckId) && isOwnerId(s.anomalyId) && isAt(s.at),
        (tx) => putWreckTagInTx(tx, s));
    },
    deleteWreckTags: (ids) => run("vendorTags.wreckDelete", (tx) => deleteWreckTagsInTx(tx, ids),
      (deleted) => ({ deleted })),
  });
}

module.exports = {
  ESCROW_TABLE,
  WRECK_TABLE,
  TAG_STORE_METHODS,
  upVendorTags,
  isOrderId,
  getEscrowTagInTx,
  listEscrowTagsInTx,
  putEscrowTagInTx,
  deleteEscrowTagsInTx,
  getWreckTagInTx,
  listWreckTagsInTx,
  putWreckTagInTx,
  deleteWreckTagsInTx,
  importTagsInTx,
  createVendorTagStore,
};
