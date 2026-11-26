"use strict";

const { listDeliveredTripsAfter } = require("../../../economy/mining/tripRepository");
const { listDeliveredJobsAfter } = require("../../../economy/production/jobRepository");
const { listDeliveredConvoysAfter } = require("../../../economy/logistics/convoyRepository");
const { listPlayerDeliveriesAfter } = require("../../../economy/trade/offerRepository");

const BOOTSTRAP = "bootstrap";

const READERS = Object.freeze({ mining: listDeliveredTripsAfter, production: listDeliveredJobsAfter,
  convoys: listDeliveredConvoysAfter, trade: listPlayerDeliveriesAfter });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const refusal = (r, detail) => ({ ok: false, reason: String((r && r.reason) || "ECONOMY_READ_FAILED"),
  detail: `${detail}${r && r.detail ? `:${r.detail}` : ""}` });

function compareFacts(a, b) {
  if (a.at !== b.at) return a.at - b.at;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function economyCursor(source, stored, now, P) {
  if (stored) return { cursor: stored, event: null };
  const fromAt = Math.max(0, now - P.bootstrapLookbackMs);
  return { event: BOOTSTRAP, cursor: Object.freeze({ source, afterAt: fromAt, afterNo: 0, afterKey: "", facts: 0,
    version: 0 }) };
}

function readEconomyFacts(tx, readers, source, cursor, factionIds, now, P) {
  const read = readers && readers[source];
  if (typeof read !== "function") return { ok: false, reason: "ECONOMY_READER_MISSING", detail: source };
  const untilAt = Math.max(0, now - P.sourceLagMs);
  const base = { afterAt: cursor.afterAt, afterKey: cursor.afterKey || "", untilAt, limit: P.sourcePageRows };
  const facts = [];
  let readEnd = null;
  if (source === "trade") {
    const r = read(tx, base);
    if (!r || r.ok !== true) return refusal(r, "trade.page");
    for (const row of r.rows) {
      facts.push(Object.freeze({ source, at: row.endedAt, key: row.offerId, systemId: row.systemId,
        iskDelivered: row.iskDelivered, ...(row.side === "sell" || row.side === "buy" ? { side: row.side } : {}) }));
    }
    if (Number.isSafeInteger(r.lastAt) && typeof r.lastKey === "string") readEnd = { at: r.lastAt, key: r.lastKey };
  } else {
    for (const factionId of factionIds) {
      if (!isId(factionId)) continue;
      const r = read(tx, { ...base, factionId });
      if (!r || r.ok !== true) return refusal(r, `${source}.page.${factionId}`);
      for (const row of r.rows) facts.push(Object.freeze({ source, at: row.endedAt, key: row.id, systemId: row.systemId }));
    }
    facts.sort(compareFacts);
    facts.length = Math.min(facts.length, P.sourcePageRows);
  }
  if (readEnd) return { ok: true, facts, endAt: readEnd.at, endKey: readEnd.key };
  const last = facts.length > 0 ? facts[facts.length - 1] : null;
  return { ok: true, facts, endAt: last ? last.at : cursor.afterAt, endKey: last ? last.key : cursor.afterKey || "" };
}

module.exports = { READERS, BOOTSTRAP, economyCursor, readEconomyFacts, compareFacts };
