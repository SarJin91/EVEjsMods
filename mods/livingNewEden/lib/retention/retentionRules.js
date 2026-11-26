"use strict";

const STATE_DONE = "DONE";
const KIND_APPLY = "APPLY";
const STATE_APPLIED = "APPLIED";
const TABLE_JOURNAL = "journal";

function planClassBatch(input) {
  const { rows, cls, cutoff, room } = input;
  const journal = cls.table === TABLE_JOURNAL;
  const doomed = [];
  const skipped = { young: 0, pattern: 0, state: 0 };
  let truncated = false;
  let lastAcceptedKey = null;
  for (const row of rows) {
    const at = journal ? row.createdAt : row.finishedAt;
    if (!cls.pattern.test(row.key) || (!journal && row.eventType !== cls.eventType)) {
      skipped.pattern += 1;
    } else if (journal ? row.kind !== KIND_APPLY || row.state !== STATE_APPLIED : row.state !== STATE_DONE) {
      skipped.state += 1;
    } else if (at === null || at === undefined || !(at < cutoff)) {
      skipped.young += 1;
    } else if (doomed.length < room) {
      doomed.push(journal ? { journalId: row.journalId, guardKey: cls.guard(row.key) } : row.key);
    } else {
      truncated = true;
      break;
    }
    lastAcceptedKey = row.key;
  }
  return { doomed, skipped, truncated, lastAcceptedKey };
}

function filterGuarded(doomed, states) {
  const journalIds = [];
  let guarded = 0;
  for (const d of doomed) {
    const state = states.get(d.guardKey);
    if (state === undefined || state === STATE_DONE) journalIds.push(d.journalId);
    else guarded += 1;
  }
  return { journalIds, guarded };
}

module.exports = { planClassBatch, filterGuarded };
