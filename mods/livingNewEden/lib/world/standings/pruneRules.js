"use strict";

const S = require("./schema");

const GRANT_KIND = "OUTBOX";
const TERMINAL = Object.freeze(["APPLIED", "FAILED"]);

function planCharacterPrune(input) {
  const { now, retentionMs, receiptGraceMs } = input;
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const receiptKeys = Array.isArray(input.receiptKeys) ? input.receiptKeys : [];
  const afterKey = typeof input.afterKey === "string" ? input.afterKey : null;
  const last = typeof input.lastScannedKey === "string" ? input.lastScannedKey : null;
  const kept = { pending: 0, fresh: 0, openDay: 0, foreign: 0, unparsed: 0, undecided: 0 };
  const closedBefore = now - retentionMs;
  const graceBefore = now - receiptGraceMs;
  const dayClosed = (parsed) => S.dayEndMs(parsed.day) <= closedBefore;
  const scanned = (key) => (afterKey === null || key > afterKey)
    && (input.scanComplete === true || (last !== null && key <= last));

  const rowByKey = new Map();
  for (const row of rows) if (row && typeof row.key === "string") rowByKey.set(row.key, row);
  const isGrant = (row) => row.kind === GRANT_KIND && row.eventType === S.EVENT_TYPE;

  const receiptsToDelete = [];
  let orphans = 0;
  for (const key of receiptKeys) {
    const row = rowByKey.get(key);
    if (row) {
      if (!isGrant(row)) kept.foreign += 1;
      else if (!TERMINAL.includes(row.state)) kept.pending += 1;
      else if ((row.appliedAt === null || row.appliedAt === undefined ? row.createdAt : row.appliedAt) <= graceBefore) {
        receiptsToDelete.push(key);
      } else kept.fresh += 1;
      continue;
    }
    if (!scanned(key)) {
      kept.undecided += 1;
      continue;
    }
    const parsed = S.parseGrantKey(key);
    if (!parsed) kept.unparsed += 1;
    else if (!dayClosed(parsed)) kept.openDay += 1;
    else {
      receiptsToDelete.push(key);
      orphans += 1;
    }
  }

  const present = new Set(receiptKeys);
  const deleting = new Set(receiptsToDelete);
  const rowsIfReceiptGone = [];
  for (const row of rows) {
    if (!row || typeof row.key !== "string") continue;
    if (!isGrant(row)) {
      kept.foreign += present.has(row.key) ? 0 : 1;
      continue;
    }
    if (!TERMINAL.includes(row.state)) continue;
    const parsed = S.parseGrantKey(row.key);
    if (!parsed || !dayClosed(parsed)) continue;
    if (present.has(row.key) && !deleting.has(row.key)) continue;
    rowsIfReceiptGone.push({ journalId: row.journalId, key: row.key });
  }
  return { receiptsToDelete, rowsIfReceiptGone, kept, orphans };
}

module.exports = { planCharacterPrune };
